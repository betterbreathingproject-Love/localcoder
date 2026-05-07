'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { PostWriteCache } = require('../post-write-cache.js')

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwc-'))
  const p = path.join(dir, 'test.txt')
  fs.writeFileSync(p, content)
  return { p, dir }
}

describe('PostWriteCache', () => {

  it('serves content cached after a write', () => {
    const cache = new PostWriteCache()
    const { p, dir } = makeTmpFile('hello world')
    try {
      cache.recordWrite(p, 'hello world', 1)
      const hit = cache.tryServe(p, 2)
      assert.ok(hit)
      assert.equal(hit.content, 'hello world')
      assert.equal(hit.ageInTurns, 1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns null on cache miss', () => {
    const cache = new PostWriteCache()
    const hit = cache.tryServe('/nonexistent.js', 0)
    assert.equal(hit, null)
  })

  it('invalidates when file is externally modified', () => {
    const cache = new PostWriteCache()
    const { p, dir } = makeTmpFile('original')
    try {
      cache.recordWrite(p, 'original', 1)
      // Simulate external modification by touching mtime
      const future = Date.now() + 10000
      fs.utimesSync(p, future / 1000, future / 1000)
      const hit = cache.tryServe(p, 2)
      assert.equal(hit, null, 'should invalidate on mtime mismatch')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('respects TTL', () => {
    const cache = new PostWriteCache({ ttlTurns: 3 })
    const { p, dir } = makeTmpFile('x')
    try {
      cache.recordWrite(p, 'x', 1)
      assert.ok(cache.tryServe(p, 2), 'within TTL')
      assert.ok(cache.tryServe(p, 4), 'at TTL boundary')
      assert.equal(cache.tryServe(p, 5), null, 'past TTL')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('evicts oldest when over capacity', () => {
    const cache = new PostWriteCache({ maxEntries: 2 })
    const files = []
    for (let i = 0; i < 4; i++) {
      const { p, dir } = makeTmpFile(`file ${i}`)
      cache.recordWrite(p, `file ${i}`, i)
      files.push({ p, dir })
    }
    try {
      assert.equal(cache.stats().entries, 2)
      // Oldest two should be evicted
      assert.equal(cache.tryServe(files[0].p, 4), null)
      assert.equal(cache.tryServe(files[1].p, 4), null)
      assert.ok(cache.tryServe(files[2].p, 3))
      assert.ok(cache.tryServe(files[3].p, 3))
    } finally {
      for (const f of files) fs.rmSync(f.dir, { recursive: true })
    }
  })

  it('invalidates manually', () => {
    const cache = new PostWriteCache()
    const { p, dir } = makeTmpFile('x')
    try {
      cache.recordWrite(p, 'x', 1)
      cache.invalidate(p)
      assert.equal(cache.tryServe(p, 2), null)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('handles missing files gracefully', () => {
    const cache = new PostWriteCache()
    const { p, dir } = makeTmpFile('x')
    cache.recordWrite(p, 'x', 1)
    fs.rmSync(dir, { recursive: true })
    const hit = cache.tryServe(p, 2)
    assert.equal(hit, null)
  })

  it('tracks stats', () => {
    const cache = new PostWriteCache()
    const { p, dir } = makeTmpFile('a')
    try {
      cache.recordWrite(p, 'a', 1)
      cache.tryServe(p, 2) // hit
      cache.tryServe('/nonexistent', 2) // miss
      const s = cache.stats()
      assert.equal(s.hits, 1)
      assert.equal(s.misses, 1)
      assert.equal(s.hit_rate, 0.5)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
