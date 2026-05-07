'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { repairAndValidate, buildRepairFeedback } = require('../constrained-decoder.js')

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todos',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
              },
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]

describe('constrained-decoder', () => {

  describe('repairAndValidate - well-formed', () => {
    it('passes through a valid tool call', () => {
      const tc = {
        id: 'x',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/main.js"}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
      assert.equal(r.issues.length, 0)
    })
  })

  describe('repairAndValidate - key renames', () => {
    it('renames "args" to "arguments"', () => {
      const tc = {
        function: { name: 'read_file', args: '{"path":"x.js"}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.ok(r.issues.includes('renamed args→arguments'))
      assert.equal(r.valid, true)
    })

    it('renames "params" to "arguments"', () => {
      const tc = {
        function: { name: 'read_file', params: { path: 'x.js' } },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })

    it('renames "tool" to "name"', () => {
      const tc = {
        function: { tool: 'read_file', arguments: '{"path":"x.js"}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })

    it('hoists flat shape into function object', () => {
      const tc = {
        name: 'read_file',
        arguments: '{"path":"x.js"}',
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })
  })

  describe('repairAndValidate - JSON repairs', () => {
    it('fixes trailing commas', () => {
      const tc = {
        function: { name: 'read_file', arguments: '{"path":"x.js",}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })

    it('fixes single quotes', () => {
      const tc = {
        function: { name: 'read_file', arguments: "{'path':'x.js'}" },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })

    it('fixes missing closing brace', () => {
      const tc = {
        function: { name: 'read_file', arguments: '{"path":"x.js"' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, true)
    })

    it('strips markdown fences', () => {
      const tc = {
        function: { name: 'read_file', arguments: '```json\n{"path":"x.js"}\n```' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.ok(r.issues.includes('stripped markdown fence'))
      assert.equal(r.valid, true)
    })
  })

  describe('repairAndValidate - type coercion', () => {
    it('coerces string number to number', () => {
      const tc = {
        function: { name: 'read_file', arguments: '{"path":"x.js","start_line":"5"}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      const parsed = JSON.parse(r.repaired.function.arguments)
      assert.equal(typeof parsed.start_line, 'number')
      assert.equal(parsed.start_line, 5)
    })
  })

  describe('repairAndValidate - failures', () => {
    it('rejects unknown tool', () => {
      const tc = {
        function: { name: 'nonexistent_tool', arguments: '{}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, false)
      assert.ok(r.issues.some(i => i.includes('unknown tool')))
    })

    it('reports missing required field', () => {
      const tc = {
        function: { name: 'read_file', arguments: '{}' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, false)
      assert.ok(r.issues.some(i => i.includes('missing required field: path')))
    })

    it('rejects invalid JSON that cannot be repaired', () => {
      const tc = {
        function: { name: 'read_file', arguments: 'this is not json at all <<<' },
      }
      const r = repairAndValidate(tc, TOOL_DEFS)
      assert.equal(r.valid, false)
    })
  })

  describe('buildRepairFeedback', () => {
    it('includes tool name and issues', () => {
      const tc = { function: { name: 'read_file' } }
      const msg = buildRepairFeedback(tc, TOOL_DEFS, ['missing required field: path'])
      assert.ok(msg.includes('read_file'))
      assert.ok(msg.includes('missing required field: path'))
      assert.ok(msg.includes('Expected schema'))
    })
  })
})
