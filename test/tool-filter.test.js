'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { ToolFilter, toolSemanticText, cosine } = require('../tool-filter.js')

// ── Fake embedding server for tests ──────────────────────────────────────
// Returns deterministic embeddings based on word hashing.
// Similar words → similar vectors.

function mockEmbedding(text) {
  // 384-dim synthetic embedding based on word frequency
  const vec = new Array(384).fill(0)
  const words = text.toLowerCase().match(/\b\w+\b/g) || []
  for (const word of words) {
    for (let i = 0; i < word.length && i < 384; i++) {
      vec[(word.charCodeAt(i) + i) % 384] += 1
    }
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? vec.map(x => x / norm) : vec
}

function startMockServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/memory/embed') {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          try {
            const { text } = JSON.parse(body)
            const emb = mockEmbedding(text || '')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ embedding: emb, dim: emb.length }))
          } catch {
            res.writeHead(500); res.end('bad')
          }
        })
        return
      }
      res.writeHead(404); res.end()
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

function makeTool(name, description, params = {}) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: params },
    },
  }
}

describe('ToolFilter', () => {

  describe('toolSemanticText', () => {
    it('extracts meaningful text from tool def', () => {
      const tool = makeTool('read_file', 'Read a file from disk', { path: {}, start_line: {} })
      const text = toolSemanticText(tool)
      assert.ok(text.includes('read_file'))
      assert.ok(text.includes('Read a file'))
      assert.ok(text.includes('path'))
    })

    it('handles missing parameters', () => {
      const tool = { type: 'function', function: { name: 'x', description: 'y' } }
      const text = toolSemanticText(tool)
      assert.ok(text.includes('x'))
      assert.ok(text.includes('y'))
    })
  })

  describe('cosine', () => {
    it('identical vectors = 1', () => {
      const v = [1, 2, 3]
      assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9)
    })

    it('orthogonal vectors = 0', () => {
      assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0)
    })

    it('opposite vectors = -1', () => {
      const s = cosine([1, 2], [-1, -2])
      assert.ok(Math.abs(s - (-1)) < 1e-9)
    })

    it('handles zero vectors', () => {
      assert.equal(cosine([0, 0], [1, 1]), 0)
    })

    it('returns 0 on mismatched lengths', () => {
      assert.equal(cosine([1, 2], [1, 2, 3]), 0)
    })
  })
})

describe('ToolFilter with mock server', () => {
  let srv
  let filter

  beforeEach(async () => {
    srv = await startMockServer()
    const port = srv.address().port
    filter = new ToolFilter({
      endpoint: `http://127.0.0.1:${port}/memory/embed`,
      topK: 5,
      minScore: 0.0,
      persistCache: false,
    })
  })

  // Close server after each test via cleanup helper
  const { afterEach } = require('node:test')
  afterEach(() => {
    if (srv) { try { srv.close() } catch {} }
  })

  it('returns all tools when under topK', async () => {
    const tools = [makeTool('a', 'desc a'), makeTool('b', 'desc b')]
    const result = await filter.filter(tools, 'some context')
    // No filtering — under topK
    assert.equal(result.tools.length, 2)
    assert.equal(result.metrics.fallback, true)
  })

  it('filters to topK + always-include when over', async () => {
    const tools = []
    for (let i = 0; i < 20; i++) {
      tools.push(makeTool(`tool_${i}`, `description for tool ${i}`))
    }
    // Add always-include tools
    tools.push(makeTool('task_complete', 'Signal task is done'))
    tools.push(makeTool('write_file', 'Write file to disk'))

    const result = await filter.filter(tools, 'write a python script')
    // Should include the 2 always-include + semantic picks up to topK
    assert.ok(result.tools.length <= 5)
    const names = result.tools.map(t => t.function.name)
    assert.ok(names.includes('task_complete'), 'task_complete always included')
    assert.ok(names.includes('write_file'), 'write_file always included')
  })

  it('caches tool embeddings across calls', async () => {
    const tools = []
    for (let i = 0; i < 15; i++) {
      tools.push(makeTool(`tool_${i}`, `description ${i}`))
    }
    await filter.filter(tools, 'context 1')
    const statsAfter1 = filter.stats()
    await filter.filter(tools, 'context 2')
    const statsAfter2 = filter.stats()
    // Second call should only compute the new prompt embedding, not re-embed tools
    assert.ok(statsAfter2.toolEmbedsComputed === statsAfter1.toolEmbedsComputed,
      'tool embeddings should be cached')
  })

  it('returns full list on embedding failure', async () => {
    const filter = new ToolFilter({
      endpoint: 'http://127.0.0.1:1/nonexistent',
      topK: 5,
      timeoutMs: 500,
      persistCache: false,
    })
    const tools = []
    for (let i = 0; i < 20; i++) tools.push(makeTool(`t${i}`, `desc ${i}`))
    const result = await filter.filter(tools, 'context')
    assert.equal(result.tools.length, 20, 'fallback to full list')
    assert.equal(result.metrics.fallback, true)
  })

  it('reports tokens saved', async () => {
    const tools = []
    for (let i = 0; i < 20; i++) {
      tools.push(makeTool(`tool_${i}`, 'x'.repeat(500)))  // long descriptions
    }
    const result = await filter.filter(tools, 'simple prompt')
    assert.ok(result.metrics.tokensSaved > 0, 'should report token savings')
  })

  it('handles empty context', async () => {
    const tools = []
    for (let i = 0; i < 15; i++) tools.push(makeTool(`t${i}`, `d${i}`))
    const result = await filter.filter(tools, '')
    assert.equal(result.tools.length, 15, 'fallback on empty context')
    assert.equal(result.metrics.fallback, true)
  })

  it('stats() tracks filter calls', async () => {
    const tools = []
    for (let i = 0; i < 15; i++) tools.push(makeTool(`t${i}`, `d${i}`))
    await filter.filter(tools, 'a')
    await filter.filter(tools, 'b')
    assert.equal(filter.stats().filterCalls, 2)
  })
})

describe('ToolFilter cache persistence', () => {
  it('persists tool embeddings to disk', async () => {
    const srv = await startMockServer()
    const port = srv.address().port
    const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-persist-'))

    try {
      // First filter — computes and persists embeddings
      const filter1 = new ToolFilter({
        endpoint: `http://127.0.0.1:${port}/memory/embed`,
        topK: 5,
        persistCache: true,
        cacheDir: tmpCacheDir,
      })
      const tools = []
      for (let i = 0; i < 15; i++) tools.push(makeTool(`tool_${i}`, `description ${i}`))
      await filter1.filter(tools, 'context')
      const stats1 = filter1.stats()
      assert.ok(stats1.toolEmbedsComputed >= 15, `expected >=15 computed, got ${stats1.toolEmbedsComputed}`)
      // Verify cache file exists
      const cachePath = path.join(tmpCacheDir, 'tool-embeddings.json')
      assert.ok(fs.existsSync(cachePath), 'cache file should exist')

      // Second filter — loads from disk, no recompute
      const filter2 = new ToolFilter({
        endpoint: `http://127.0.0.1:${port}/memory/embed`,
        topK: 5,
        persistCache: true,
        cacheDir: tmpCacheDir,
      })
      await filter2.filter(tools, 'context 2')
      const stats2 = filter2.stats()
      assert.equal(stats2.toolEmbedsComputed, 0, 'no re-compute with persisted cache')
      assert.ok(stats2.toolEmbedsFromCache >= 15)
    } finally {
      srv.close()
      try { fs.rmSync(tmpCacheDir, { recursive: true, force: true }) } catch {}
    }
  })
})
