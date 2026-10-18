// owner: U5 (physics & movement)
// Adapted from prismarine-physics 1.11.1 lib/attribute.js (MIT, Copyright (c) 2020 PrismarineJS,
// https://github.com/PrismarineJS/prismarine-physics). Same Java attribute formula: base, then operation 0
// (add), 1 (multiply base), 2 (multiply total). The Bedrock `update_attributes` modifiers use the same
// operations (lib/bedrock/entity_data.js stores the BASE value, like Java).
'use strict'

function getAttributeValue (prop) {
  let x = prop.value
  for (const mod of prop.modifiers) {
    if (mod.operation !== 0) continue
    x += mod.amount
  }
  let y = x
  for (const mod of prop.modifiers) {
    if (mod.operation !== 1) continue
    y += x * mod.amount
  }
  for (const mod of prop.modifiers) {
    if (mod.operation !== 2) continue
    y += y * mod.amount
  }
  return y
}

function createAttributeValue (base) {
  return { value: base, modifiers: [] }
}

function addAttributeModifier (attributes, modifier) {
  attributes.modifiers[attributes.modifiers.length] = modifier
  return attributes
}

function checkAttributeModifier (attributes, uuid) {
  for (const modifier of attributes.modifiers) {
    if (modifier.uuid === uuid) return true
  }
  return false
}

function deleteAttributeModifier (attributes, uuid) {
  attributes.modifiers = attributes.modifiers.filter(modifier => modifier.uuid !== uuid)
  return attributes
}

module.exports = { getAttributeValue, createAttributeValue, addAttributeModifier, checkAttributeModifier, deleteAttributeModifier }
