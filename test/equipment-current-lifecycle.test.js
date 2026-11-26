import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { grantRewards } from '../src/rewards.js'
import { nextOrnamentLevel } from '../src/ornament-upgrade.js'
import { ornamentStarPlan } from '../src/ornament-star.js'
import { ornamentSmeltPlan } from '../src/ornament-smelt.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    protocol = new Protocol(config.base)
function fixture(t, name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-equipment-current-'))
    const filename = path.join(directory, 'synthetic.sqlite')
    const tables = new Tables(config.tables),
        catalog = new WorldObjectCatalog(tables)
    let store = new Store(filename),
        game = new Game(protocol, store, tables, { rng: () => 0 }),
        session = {},
        sequence = 1
    const cache = new Map(),
        attributeCache = new Map()
    const decode = (packet) => {
        const entry = protocol.byId.get(packet.id)
        assert(entry?.rsp, `Unknown outgoing schema ${packet.id}`)
        const data = protocol.decode(entry.rsp, packet.payload)
        if (entry.name === 'CSProtoHeroAttrInfoSync')
            for (const row of data.heros ?? []) attributeCache.set(row.hero_guid, row)
        if (packet.id === 6031) cache.clear()
        if ([6029, 6031].includes(packet.id)) {
            for (const row of data.ornaments ?? []) row.del ? cache.delete(row.guid) : cache.set(row.guid, row)
            for (const guid of data.guid ?? []) cache.delete(guid)
        }
        return { id: packet.id, name: entry.name, data }
    }
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry?.req, `Missing current request ${name}`)
        return game
            .dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, request) })
            .map(decode)
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const state = () => store.load(session.id).state
    const mutate = (fn) => store.transact(session.id, 0, fn)
    const fund = (costs) => mutate((state) => grantRewards(tables, state, costs))
    const reopen = () => {
        store.close()
        store = new Store(filename)
        game = new Game(protocol, store, tables, { rng: () => 0 })
        cache.clear()
        attributeCache.clear()
        return login()
    }
    const open = (id) => {
        mutate((state) => {
            state.world.map_id = 100
            state.world.pos = catalog.object(100, id).pos
        })
        return call('WorldObjInteract', {
            objs: [{ obj: { obj_id: id, complete: true, state_data: {} }, interact_type: 0 }],
        })
    }
    t.after(() => {
        store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return { tables, catalog, cache, attributeCache, call, state, mutate, fund, reopen, open }
}

// Current IL 060296fe/060296fd derives the tooltip from config ID + lv + quality.
// 06023567/06023568 chooses the last unlocked row, or the next locked row per slot.
function clientDetail(tables, wire) {
    const cfg = tables.find('accessory', wire.id)
    assert(cfg?.name && cfg.texture.split(',').length === 3)
    assert(Number.isInteger(wire.lv) && Number.isInteger(wire.grade))
    const quality = tables.find('accessory_quality', wire.quality)
    assert(quality)
    const read = (group) =>
        tables
            .get('accessory_main')
            .filter((row) => row.groupId === group && row.level === wire.lv)
            .map((row) => ({
                id: Number(String(row.battleInfo).split('|')[0]),
                value: row.value * (1 + quality.value / 10000),
            }))
    const main = read(cfg.mainAttr),
        element = cfg.elementAttr ? read(cfg.elementAttr).slice(0, 1) : []
    assert(main.length)
    if (cfg.elementAttr) assert(element.length)
    const slots = new Map()
    for (const row of tables.get('accessory_skillEntry').filter((row) => row.groupId === cfg.subAttr)) {
        if (!slots.has(row.subAttrId)) slots.set(row.subAttrId, [])
        slots.get(row.subAttrId).push(row)
    }
    const entries = [...slots.values()].map((rows) => {
        rows.sort((a, b) => a.star - b.star)
        const selected = rows.filter((row) => row.star <= wire.grade).at(-1) ?? rows[0]
        const entry = tables
            .get('skill_entry')
            .find((row) => row.skillEntryId === selected.skillId && row.skillLv === selected.skillLv)
        assert(entry?.skillName, `Empty skill-entry name ${selected.skillId}:${selected.skillLv}`)
        return { selected, entry, locked: selected.star > wire.grade }
    })
    assert(
        main.every(
            (row) =>
                row.id > 0 &&
                Number.isFinite(row.value) &&
                tables.get('battle_info').some((cfg) => cfg.attrVal === row.id),
        ),
    )
    return { cfg, main, element, entries }
}
function equipped(f, heroId, packets) {
    const state = f.state(),
        hero = state.player.heros_info.heros.find((row) => row.guid === heroId)
    const attributes = new Map(),
        entryLevels = new Map(),
        skills = new Set()
    const add = (id, value) => attributes.set(id, (attributes.get(id) ?? 0) + value)
    for (const guid of (hero.oguid ?? []).filter(Boolean)) {
        const wire = f.cache.get(guid)
        assert.equal(wire?.wear_hero, heroId)
        const detail = clientDetail(f.tables, wire)
        // Current getMergeAttDic06029702 merges mainAtt, not the separate
        // element tooltip. Derive this expectation independently of server helpers.
        for (const row of detail.main) add(row.id, Math.trunc(row.value))
        for (const { entry, locked } of detail.entries)
            if (!locked) entryLevels.set(entry.skillEntryId, (entryLevels.get(entry.skillEntryId) ?? 0) + entry.skillLv)
    }
    for (const [id, total] of entryLevels) {
        const rows = f.tables.get('skill_entry').filter((row) => row.skillEntryId === id)
        const row = rows.find((row) => row.skillLv === Math.min(total, Math.max(...rows.map((row) => row.skillLv))))
        assert(row)
        for (const token of String(row.mainAttr).split('|').filter(Boolean)) {
            const [key, value] = token.split('#').map(Number)
            // Selected current vectors use unscaled ordinary attribute IDs.
            assert(![1, 3, 5, 201, 229, 230].includes(key))
            add(key, value)
        }
        if (row.skillId) skills.add(row.skillId)
    }
    const expected = [...attributes]
        .sort((a, b) => a[0] - b[0])
        .map(([attr_id, value]) => ({ attr_id, attr_val: String(Math.trunc(value)) }))
    // Game can suppress an identical module. The simulated client must still
    // have the exact current attributes and skills after consuming actual pushes.
    const cached = f.attributeCache.get(heroId)?.modules.find((row) => row.module_type === 2)
    assert(cached, 'No actual client accessory attribute cache')
    assert.deepEqual(cached.sub_modules[0].attrs.attrs, expected)
    assert.deepEqual(
        cached.sub_modules[0].skills.skills.map((row) => row.skill_id).sort((a, b) => a - b),
        [...skills].sort((a, b) => a - b),
    )
    if (packets)
        assert(
            packets.some((packet) => packet.id === 6029),
            'No actual accessory state synchronization',
        )
    return cached
}
const amount = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((sum, row) => sum + row.itemnum, 0)
const balance = (state, id) =>
    BigInt(
        id === 1
            ? state.player.basic_info.diamond
            : id === 2
              ? state.player.basic_info.gold
              : (state.player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? '0'),
    )

test('current field chest generates usable accessory cards before ACK; strengthen, smelt and reopen preserve actual instances', (t) => {
    const f = fixture(t, 'current-chest-equipment'),
        before = f.state()
    const preview = f.catalog.drops(6001101, () => 0).filter((row) => row.itemtype === 33)
    assert.deepEqual(
        preview.map((row) => row.itemid),
        [50001, 50006],
    )
    const packets = f.open(400358),
        acquired = f.state().ornaments.filter((row) => !(before.ornaments ?? []).some((old) => old.guid === row.guid))
    assert.equal(acquired.length, 2)
    const updateIndex = packets.findIndex((packet) => packet.id === 6029)
    const ackIndex = packets.findIndex((packet) => packet.name === 'CSProtoWorldObjInteract')
    assert(updateIndex >= 0 && updateIndex < ackIndex)
    const rewards = packets[ackIndex].data.objs.flatMap((row) => row.rewards?.rewards ?? [])
    assert(
        rewards.every((row) => row.itemtype !== 33),
        'Recipe type33 must not leak into acquired item cards',
    )
    assert.deepEqual(
        rewards
            .filter((row) => row.itemtype === 15)
            .map((row) => [row.itemid, Number(row.guid)])
            .sort(),
        acquired.map((row) => [row.id, row.guid]).sort(),
    )
    for (const item of acquired) {
        const detail = clientDetail(f.tables, f.cache.get(item.guid))
        assert.equal(detail.cfg.id, item.id)
        assert.equal(
            detail.cfg.id,
            f.tables.find(
                'accessory_customed',
                preview.find((row) => f.tables.find('accessory_customed', row.itemid).accessoryId === item.id).itemid,
            ).accessoryId,
        )
    }
    const saved = structuredClone(f.state())
    f.open(400358)
    assert.deepEqual(f.state().ornaments, saved.ornaments, 'Opening the same chest must not duplicate instances')
    const item = acquired[0],
        hero = f.state().player.heros_info.heros[0]
    equipped(f, hero.guid, f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: item.guid }))
    const worn = structuredClone(f.state())
    assert.throws(
        () => f.call('SmeltOrnament', { ornament_guid: [item.guid] }),
        (error) => error.code === ErrorCode.EquipOrnament,
    )
    assert.deepEqual(f.state(), worn)
    const plan = nextOrnamentLevel(f.tables, item)
    f.fund(plan.costs)
    const funded = f.state()
    const upgraded = f.call('UpgradeOrnament', { u32: item.guid })
    assert.equal(f.cache.get(item.guid).lv, plan.level)
    for (const cost of plan.costs.filter((cost) => cost.itemtype === 3))
        assert.equal(amount(f.state(), cost.itemid), amount(funded, cost.itemid) - cost.itemnum)
    for (const cost of plan.costs.filter((cost) => cost.itemtype === 10))
        assert.equal(balance(f.state(), cost.itemid), balance(funded, cost.itemid) - BigInt(cost.itemnum))
    equipped(f, hero.guid, upgraded)
    f.call('RemoveOrnament', { hero_id: hero.guid, type: f.tables.find('accessory', item.id).type })
    f.call('SetLockOrnament', { guid: item.guid, lock: true })
    const locked = structuredClone(f.state())
    assert.throws(
        () => f.call('SmeltOrnament', { ornament_guid: [item.guid] }),
        (error) => error.code === ErrorCode.LockOrnament,
    )
    assert.deepEqual(f.state(), locked)
    f.call('SetLockOrnament', { guid: item.guid, lock: false })
    const smelt = ornamentSmeltPlan(f.tables, f.state(), [item.guid]),
        beforeSmelt = f.state()
    const smeltPackets = f.call('SmeltOrnament', { ornament_guid: [item.guid] })
    assert(smeltPackets.some((packet) => packet.id === 6029 && packet.data.guid.includes(item.guid)))
    assert(!f.cache.has(item.guid))
    for (const reward of smelt.rewards.filter((reward) => reward.itemtype === 3))
        assert.equal(amount(f.state(), reward.itemid), amount(beforeSmelt, reward.itemid) + reward.itemnum)
    f.reopen()
    assert(!f.state().ornaments.some((row) => row.guid === item.guid))
    assert(!f.cache.has(item.guid))
    assert(f.cache.has(acquired[1].guid))
})

test('current selectable weapon gift, six star upgrades, unlocked entries and battle skills work through real Game requests', (t) => {
    const f = fixture(t, 'current-star-equipment')
    f.fund([{ itemtype: 3, itemid: 1600040, itemnum: 16 }])
    const invalid = structuredClone(f.state())
    assert.throws(
        () => f.call('UseItem', { itemid: 1600040, num: 16, args: ['33', '50005'] }),
        (error) => error.code === ErrorCode.SelectGiftItemNotExist,
    )
    assert.deepEqual(f.state(), invalid)
    const before = f.state(),
        packets = f.call('UseItem', { itemid: 1600040, num: 16, args: ['33', '14686114'] })
    assert.equal(amount(f.state(), 1600040), amount(before, 1600040) - 16)
    const items = f.state().ornaments.filter((row) => row.id === 1468611)
    assert.equal(items.length, 16)
    assert(items.every((row) => row.quality === 3))
    assert(
        packets.findIndex((packet) => packet.id === 6029) <
            packets.findIndex((packet) => packet.name === 'CSProtoUseItem'),
    )
    const rewardCards = packets.find((packet) => packet.name === 'CSProtoUseItem').data.rewards
    assert.equal(rewardCards.length, 16)
    assert(rewardCards.every((row) => row.itemtype === 15 && row.itemid === 1468611 && f.cache.has(Number(row.guid))))
    const target = items[0],
        hero = f.state().player.heros_info.heros[0]
    const detail = clientDetail(f.tables, f.cache.get(target.guid))
    assert(detail.element.length && detail.entries.some((entry) => entry.locked))
    equipped(f, hero.guid, f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: target.guid }))
    for (let star = 1; star <= 6; star++) {
        const state = f.state(),
            row = f.tables.get('accessory_upgrade').find((row) => row.rarity === 4 && row.grade === star)
        const donors = state.ornaments
            .filter((row) => row.id === target.id && row.guid !== target.guid)
            .slice(0, row.count)
        const request = { target_guid: target.guid, material_guids: donors.map((row) => row.guid) }
        const plan = ornamentStarPlan(f.tables, state, request)
        f.fund(plan.costs)
        const funded = f.state(),
            updates = f.call('OrnamentGradeUp', request)
        assert.equal(f.cache.get(target.guid).grade, star)
        assert(donors.every((row) => !f.cache.has(row.guid)))
        assert.equal(
            f.state().player.basic_info.gold,
            funded.player.basic_info.gold -
                plan.costs
                    .filter((row) => row.itemtype === 10 && row.itemid === 2)
                    .reduce((sum, row) => sum + row.itemnum, 0),
        )
        clientDetail(f.tables, f.cache.get(target.guid))
        const module = equipped(f, hero.guid, updates)
        if (star >= 3) assert(module.sub_modules[0].skills.skills.some((row) => row.skill_id === 19991015))
        if (star >= 4) assert(module.sub_modules[0].skills.skills.some((row) => row.skill_id === 19991014))
    }
    assert.equal(f.state().ornaments.filter((row) => row.id === target.id).length, 1)
    const saved = structuredClone(f.state())
    assert.throws(
        () => f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: [] }),
        (error) => error.code === ErrorCode.InvalidArgument && error.message === 'Ornament is at maximum star',
    )
    assert.deepEqual(f.state(), saved)
    f.reopen()
    assert.equal(f.cache.get(target.guid).grade, 6)
    assert(equipped(f, hero.guid).sub_modules[0].skills.skills.length >= 2)
})

test('the shared type33 grant honors an explicit quality RNG without changing configured instance type or identity', () => {
    const tables = new Tables(config.tables)
    for (const [draw, quality] of [
        [() => 0, 1],
        [(maximum) => maximum - 1, 4],
    ]) {
        const state = { ornaments: [] }
        const acquired = grantRewards(tables, state, [{ itemtype: 33, itemid: 50005, itemnum: 1 }], 0, {
            randomInt: draw,
        })
        assert.equal(state.ornaments[0].quality, quality)
        assert.deepEqual(acquired, [
            { itemtype: 15, itemid: 1050111, itemnum: 1, guid: String(state.ornaments[0].guid) },
        ])
    }
})

test('configured quality recipes retain both instances when inheritance swaps quality, including worn/locked receiver and SQLite reload', (t) => {
    const f = fixture(t, 'current-inherit-equipment')
    const text = (value) => Buffer.from(String(value)).toString('base64')
    for (const id of [13722113, 13722114, 13722113])
        f.call('GMCommand', { command: text('give'), args: [33, id, 1].map(text) })
    const generated = f.state().ornaments.filter((row) => row.id === 1372211)
    const current = generated.find((row) => row.quality === 3),
        candidate = generated.find((row) => row.quality === 4)
    assert.deepEqual([current.quality, candidate.quality], [3, 4])
    const hero = f.state().player.heros_info.heros[0]
    f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: current.guid })
    f.call('SetLockOrnament', { guid: current.guid, lock: true })
    f.call('SetLockOrnament', { guid: candidate.guid, lock: true })
    const level = nextOrnamentLevel(f.tables, current)
    f.fund(level.costs)
    f.call('UpgradeOrnament', { u32: current.guid })
    const material = generated.find((row) => row.guid !== current.guid && row.guid !== candidate.guid)
    const starRequest = { target_guid: current.guid, material_guids: [material.guid] }
    const starPlan = ornamentStarPlan(f.tables, f.state(), starRequest)
    f.fund(starPlan.costs)
    f.call('OrnamentGradeUp', starRequest)
    const cost = Number(f.tables.get('game').find((row) => row.title === 'ACCESSORY_INHERIT_CURRENCY_COST').value)
    const request = { target_quality_guid: candidate.guid, source_quality_guid: current.guid }
    f.mutate((state) => {
        state.player.basic_info.gold = 0
    })
    const insufficient = structuredClone(f.state())
    assert.throws(
        () => f.call('OrnamentInherit', request),
        (error) => error.code === ErrorCode.ItemNotEnough,
    )
    assert.deepEqual(f.state(), insufficient)
    f.fund([{ itemtype: 10, itemid: 2, itemnum: cost }])
    const funded = f.state(),
        packets = f.call('OrnamentInherit', request)
    assert.equal(f.state().ornaments.length, funded.ornaments.length)
    const received = f.state().ornaments.find((row) => row.guid === current.guid)
    const donor = f.state().ornaments.find((row) => row.guid === candidate.guid)
    assert.deepEqual(received, { ...funded.ornaments.find((row) => row.guid === current.guid), quality: 4 })
    assert.deepEqual(donor, { ...funded.ornaments.find((row) => row.guid === candidate.guid), quality: 3 })
    assert.equal(f.state().player.basic_info.gold, 0)
    equipped(f, hero.guid, packets)
    clientDetail(f.tables, f.cache.get(current.guid))
    f.reopen()
    assert.equal(f.cache.get(current.guid).quality, 4)
    assert.equal(f.cache.get(current.guid).lv, 1)
    assert.equal(f.cache.get(current.guid).grade, 1)
    assert.equal(f.cache.get(candidate.guid).quality, 3)
    assert.equal(f.cache.get(current.guid).wear_hero, hero.guid)
    equipped(f, hero.guid)
})
