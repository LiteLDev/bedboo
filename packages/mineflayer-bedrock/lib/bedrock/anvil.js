// owner: U13 (stations)
// Adapted from prismarine-item 1.18.0 lib/anvil.js (MIT, Copyright (c) 2015-2016 PrismarineJS,
// https://github.com/PrismarineJS/prismarine-item): same `combine(itemOne, itemTwo, creative, renamedName)
// → { xpCost, item, usedMats }` contract (prismarine-item has no Bedrock anvil: `Item.anvil` is undefined there),
// with the Bedrock Edition rules.
'use strict'

/**
 * Bedrock anvil rules (minecraft.wiki "Anvil mechanics", checked against BDS 1.26.51.1):
 * - enchantment cost = multiplier × (final level − level already on the target); an enchantment the sacrifice adds
 *   at its own level costs multiplier × level; incompatible enchantments are dropped and cost nothing (Java: +1);
 * - multipliers: the Bedrock table (Impaling 2/1, Loyalty 1/1 differ from the weight-derived values), halved
 *   (min 1) for an enchanted-book sacrifice;
 * - rename +1; repair with materials 1 per unit (25 % of the max durability each), with the same item 2 (the
 *   sacrifice's durability + 12 %); the prior work penalties (RepairCost) of both inputs are added;
 * - "Too Expensive!" at 40 levels outside creative, a rename included (Java caps a rename at 39);
 * - result: RepairCost = 2 × max(penalties) + 1, a rename alone keeps the target's penalty (observed: a fresh item
 *   renamed keeps RepairCost 0); NBT order as BDS writes it: RepairCost, display, ench, then the rest.
 * The server computes the real result; this is the client's prediction (BDS does not send the result back).
 */

/** Bedrock item cost multipliers (book = max(1, item / 2)) */
const MULTIPLIERS = {
  protection: 1,
  fire_protection: 2,
  feather_falling: 2,
  blast_protection: 4,
  projectile_protection: 2,
  thorns: 8,
  respiration: 4,
  depth_strider: 4,
  aqua_affinity: 4,
  sharpness: 1,
  smite: 2,
  bane_of_arthropods: 2,
  knockback: 2,
  fire_aspect: 4,
  looting: 4,
  efficiency: 1,
  silk_touch: 8,
  unbreaking: 2,
  fortune: 4,
  power: 1,
  punch: 4,
  flame: 4,
  infinity: 8,
  luck_of_the_sea: 4,
  lure: 4,
  frost_walker: 4,
  mending: 4,
  binding_curse: 8,
  vanishing_curse: 8,
  impaling: 2,
  riptide: 4,
  loyalty: 1,
  channeling: 8,
  multishot: 4,
  piercing: 1,
  quick_charge: 2,
  soul_speed: 8,
  swift_sneak: 8,
  wind_burst: 4,
  density: 2,
  breach: 4,
  lunge: 2
}
const WEIGHT_MULTIPLIER = { 10: 1, 5: 2, 2: 4, 1: 8 }

const ARMOR = ['armor_head', 'armor_torso', 'armor_legs', 'armor_feet']
/** enchantment (or its data category) → item enchantCategories it applies to; 'breakable' = any damageable item */
const APPLIES_TO = {
  // per enchantment where Bedrock differs from the data category
  sharpness: ['sword', 'axe', 'melee_spear'],
  smite: ['sword', 'axe', 'melee_spear', 'heavy_weapon'],
  bane_of_arthropods: ['sword', 'axe', 'melee_spear', 'heavy_weapon'],
  knockback: ['sword', 'melee_spear'],
  fire_aspect: ['sword', 'melee_spear', 'heavy_weapon'],
  looting: ['sword', 'melee_spear'],
  efficiency: ['pickaxe', 'shovel', 'axe', 'hoe', 'shears'],
  thorns: ARMOR, // enchanting table: chestplates only; anvil: any armor piece
  silk_touch: ['pickaxe', 'shovel', 'axe', 'hoe', 'shears'],
  // data categories
  armor: ARMOR,
  armor_head: ['armor_head'],
  armor_chest: ['armor_torso'],
  armor_legs: ['armor_legs'],
  armor_feet: ['armor_feet'],
  weapon: ['sword', 'axe'],
  digger: ['pickaxe', 'shovel', 'axe', 'hoe'],
  bow: ['bow'],
  fishing_rod: ['fishing_rod'],
  trident: ['spear'],
  crossbow: ['crossbow'],
  mace: ['heavy_weapon'],
  lunge: ['melee_spear'],
  breakable: ['breakable'],
  wearable: [...ARMOR, 'elytra', 'cosmetic_head'],
  vanishable: ['breakable', 'compass', 'cosmetic_head']
}

const TOO_EXPENSIVE = 40
const MAX_REPAIR_COST = 0x7fffffff

function loader (registry) {
  const enchantment = (name) => registry.enchantmentsByName[name]

  function multiplier (name, isBook) {
    const data = enchantment(name)
    const item = MULTIPLIERS[name] ?? WEIGHT_MULTIPLIER[data?.weight] ?? 1
    return isBook ? Math.max(1, Math.floor(item / 2)) : item
  }

  function itemCategories (item) {
    const def = registry.itemsByName[item.name]
    const cats = [...(def?.enchantCategories ?? [])]
    if (def?.maxDurability) cats.push('breakable')
    return cats
  }

  /** the `ench` list of an item: [{ id, name, lvl }] (name null for an id this registry does not know) */
  function enchList (item) {
    const list = item?.nbt?.value?.ench?.value?.value ?? []
    return list.map(e => {
      const id = Number(e?.id?.value)
      return { id, lvl: Number(e?.lvl?.value), name: registry.enchantments[id]?.name ?? null }
    })
  }

  /** can enchantment `name` go onto `item` (an enchanted book takes everything) */
  function applicable (item, name) {
    const cats = itemCategories(item)
    if (cats.includes('all')) return true
    const targets = APPLIES_TO[name] ?? APPLIES_TO[enchantment(name)?.category] ?? []
    return targets.some(t => cats.includes(t))
  }

  function incompatible (a, b) {
    const ea = enchantment(a)
    const eb = enchantment(b)
    return !!(ea?.exclude?.includes(b) || eb?.exclude?.includes(a))
  }

  function combinePossible (itemOne, itemTwo) {
    if (!itemOne?.name || !itemTwo?.name) return false
    if (itemOne.name === 'book') return false // a plain book is enchanted at a table, not with an anvil
    let fixMaterials = (registry.itemsByName[itemOne.name]?.repairWith ?? []).concat([itemOne.name])
    if (itemOne.name !== 'enchanted_book') fixMaterials = fixMaterials.concat(['enchanted_book'])
    return fixMaterials.includes(itemTwo.name)
  }

  /** @returns {{ xpLevelCost: number, finalEnchs: Array<{ id: number, name: string|null, lvl: number }>, changed: boolean }} */
  function combineEnchants (itemOne, itemTwo) {
    const rightIsBook = itemTwo.name === 'enchanted_book'
    const finalEnchs = enchList(itemOne)
    let xpLevelCost = 0
    let changed = false
    for (const ench of enchList(itemTwo)) {
      if (!ench.name || !enchantment(ench.name)) continue // an enchantment this registry does not know
      if (!(itemOne.name === 'enchanted_book' && rightIsBook) && !applicable(itemOne, ench.name)) continue
      const mult = multiplier(ench.name, rightIsBook)
      const onOne = finalEnchs.find(x => x.id === ench.id)
      if (!onOne) {
        if (finalEnchs.some(x => x.name && incompatible(x.name, ench.name))) continue // Bedrock: dropped, no cost
        finalEnchs.push({ id: ench.id, name: ench.name, lvl: ench.lvl })
        xpLevelCost += ench.lvl * mult
        changed = true
        continue
      }
      const maxLevel = enchantment(ench.name).maxLevel ?? ench.lvl
      const finalLevel = onOne.lvl === ench.lvl ? Math.min(onOne.lvl + 1, Math.max(maxLevel, onOne.lvl)) : Math.max(onOne.lvl, ench.lvl)
      if (finalLevel > onOne.lvl) {
        xpLevelCost += (finalLevel - onOne.lvl) * mult
        onOne.lvl = finalLevel
        changed = true
      }
    }
    return { xpLevelCost, finalEnchs, changed }
  }

  /** @returns {{ xpLevelCost: number, fixedDurability: number, usedMats: number }} */
  function getRepairCost (itemOne, itemTwo) {
    const none = { xpLevelCost: 0, fixedDurability: 0, usedMats: 0 }
    if (!itemTwo || itemTwo.name === 'enchanted_book') return none
    const maxDurability = registry.itemsByName[itemOne.name]?.maxDurability
    const used = itemOne.durabilityUsed ?? 0
    if (!maxDurability || !used) return none
    if (itemTwo.name === itemOne.name) {
      const remainingTwo = maxDurability - (itemTwo.durabilityUsed ?? 0)
      const fixed = Math.min(used, remainingTwo + Math.floor(0.12 * maxDurability))
      return { xpLevelCost: 2, fixedDurability: fixed, usedMats: 1 }
    }
    const materials = registry.itemsByName[itemOne.name]?.repairWith ?? []
    if (!materials.includes(itemTwo.name)) return none
    const perMat = Math.floor(maxDurability * 0.25)
    const needed = Math.ceil(used / perMat)
    const mats = Math.min(needed, itemTwo.count)
    return { xpLevelCost: mats, fixedDurability: Math.min(used, perMat * mats), usedMats: mats }
  }

  /**
   * @param {object} itemOne the target (left slot)
   * @param {object|null} itemTwo the sacrifice (right slot)
   * @param {boolean} creative
   * @param {string} [renamedName] a new name (a string = rename)
   * @param {Function} Item prismarine-item class (for the predicted result)
   * @returns {{ xpCost: number, item: object|null, usedMats?: number }}
   */
  function combine (itemOne, itemTwo, creative, renamedName, Item) {
    const rename = typeof renamedName === 'string' && renamedName !== (itemOne?.customName ?? null)
    if (!itemOne) return { xpCost: 0, item: null }
    if (itemTwo !== null && itemTwo !== undefined && !combinePossible(itemOne, itemTwo)) return { xpCost: 0, item: null }
    itemTwo = itemTwo ?? null
    let cost = 0
    let changed = false
    if (rename) {
      if (itemOne.repairCost >= MAX_REPAIR_COST) return { xpCost: 0, item: null }
      cost += 1
      changed = true
    }
    const repair = getRepairCost(itemOne, itemTwo)
    if (repair.fixedDurability > 0) {
      cost += repair.xpLevelCost
      changed = true
    }
    let finalEnchs = null
    if (itemTwo && (itemTwo.name === itemOne.name || itemTwo.name === 'enchanted_book')) {
      const res = combineEnchants(itemOne, itemTwo)
      if (res.changed) {
        finalEnchs = res.finalEnchs
        cost += res.xpLevelCost
        changed = true
      }
    }
    // a sacrifice that changes nothing (repair material on an undamaged item, …) gives no result, renamed or not
    if (!changed || (itemTwo && repair.fixedDurability === 0 && finalEnchs === null)) return { xpCost: 0, item: null }
    const onlyRename = rename && repair.fixedDurability === 0 && finalEnchs === null
    cost += itemOne.repairCost + (itemTwo?.repairCost ?? 0)
    if (!creative && cost >= TOO_EXPENSIVE) return { xpCost: 0, item: null }

    let item = null
    if (Item) {
      const old = JSON.parse(JSON.stringify(itemOne.nbt?.value ?? {}))
      const value = {}
      value.RepairCost = { type: 'int', value: onlyRename ? itemOne.repairCost : Math.max(itemOne.repairCost, itemTwo?.repairCost ?? 0) * 2 + 1 }
      if (rename) {
        const display = old.display?.type === 'compound' ? old.display : { type: 'compound', value: {} }
        display.value.Name = { type: 'string', value: renamedName }
        value.display = display
      } else if (old.display) {
        value.display = old.display
      }
      const enchs = finalEnchs ?? null
      if (enchs) {
        value.ench = { type: 'list', value: { type: 'compound', value: enchs.map(e => ({ id: { type: 'short', value: e.id }, lvl: { type: 'short', value: e.lvl } })) } }
      } else if (old.ench) {
        value.ench = old.ench
      }
      for (const [key, tag] of Object.entries(old)) {
        if (!(key in value) && key !== 'RepairCost') value[key] = tag
      }
      if (repair.fixedDurability > 0) {
        const damage = (itemOne.durabilityUsed ?? 0) - repair.fixedDurability
        if (damage > 0) value.Damage = { type: 'int', value: damage }
        else delete value.Damage
      }
      item = new Item(itemOne.type, itemOne.count, itemOne.metadata, { type: 'compound', name: '', value }, null, true)
    }
    return { xpCost: cost, item, usedMats: repair.usedMats }
  }

  return combine
}

module.exports = loader
module.exports.MULTIPLIERS = MULTIPLIERS
