'use strict'
// lib/bedrock/commands.js: the 'valid' value type ids differ per family (1.26.40: command = 88, 1.26.51: 90)
const { describe, it } = require('node:test')
const assert = require('assert')
const { createCommandTree, valueTypeKinds } = require('../../lib/bedrock/commands')

/** a minimal available_commands: `/say <message>` and `/execute run <command>` with the given command type id */
function availableCommands (commandTypeId) {
  const param = (name, valueType) => ({ parameter_name: name, value_type: valueType, enum_type: 'valid', optional: false, options: {} })
  return {
    enum_values: ['run'],
    chained_subcommand_values: [],
    suffixes: [],
    enums: [{ name: 'Option_Run', values: [0] }],
    chained_subcommands: [],
    command_data: [
      { name: 'say', description: '', flags: 0, permission_level: 'any', alias: -1, chained_subcommand_offsets: [], overloads: [{ chaining: false, parameters: [param('message', 68)] }] },
      {
        name: 'execute',
        description: '',
        flags: 0,
        permission_level: 'any',
        alias: -1,
        chained_subcommand_offsets: [],
        overloads: [{ chaining: false, parameters: [{ parameter_name: 'subcommand', value_type: 0, enum_type: 'enum', optional: false, options: {} }, param('command', commandTypeId)] }]
      }
    ],
    dynamic_enums: [],
    enum_constraints: []
  }
}

describe('command value types per family', () => {
  it('1.26.40 numbers `command` 88 (BDS 1.26.44.3); the other kinds keep their 1.26.51 ids', () => {
    const base = valueTypeKinds('1.26.51')
    const v40 = valueTypeKinds('1.26.40')
    assert.strictEqual(base[90], 'command')
    assert.strictEqual(base[88], undefined)
    assert.strictEqual(v40[88], 'command')
    assert.strictEqual(v40[90], undefined)
    for (const id of [8, 10, 64, 65, 68, 70, 74]) assert.strictEqual(v40[id], base[id], String(id))
    assert.deepStrictEqual(valueTypeKinds('1.26.45'), v40, '1.26.45 (BDS 1.26.45.1) numbers them like 1.26.40')
    assert.strictEqual(valueTypeKinds('1.26.60'), base, '1.26.60 (BDS 1.26.60.6 – 1.26.63.1) numbers them like 1.26.51')
    assert.strictEqual(valueTypeKinds('1.26.63.1'), base)
  })

  it('/execute run <command> recurses with the family\'s id', () => {
    for (const [version, id] of [['1.26.40', 88], ['1.26.44.3', 88], ['1.26.45', 88], ['1.26.45.1', 88], ['1.26.51', 90], ['1.26.60', 90], ['1.26.62.1', 90]]) {
      const tree = createCommandTree({ version })
      tree.update(availableCommands(id))
      assert.deepStrictEqual(tree.complete('/execute run s'), ['say'], version)
    }
    // the other family's id is not a command there (no recursion)
    for (const [version, id] of [['1.26.40', 90], ['1.26.45', 90], ['1.26.51', 88]]) {
      const tree = createCommandTree({ version })
      tree.update(availableCommands(id))
      assert.deepStrictEqual(tree.complete('/execute run s'), [], version)
    }
  })
})
