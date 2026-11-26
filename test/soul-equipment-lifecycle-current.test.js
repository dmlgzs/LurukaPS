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
import { ErrorCode } from '../src/error-codes.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const soulId = 10044,
    heroId = 107002,
    now = 1800000000
const setting = (name) => tables.get('game').find((row) => row.title === name).value
const material = Number(String(setting('SOULESSENCE_EXP_ITEM')).split('|')[0])
const expPerItem = Number(tables.find('common_item', material).useFunction)
const goldPerItem = Math.floor((expPerItem * Number(setting('WEAPON_LEVELUP_GOLD'))) / 10000)
const amount = (state, id) =>
    state.player.sbag_infos.items.filter((item) => item.itemid === id).reduce((n, item) => n + item.itemnum, 0)

function fixture(t, name) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-soul-flow-current-')),
        filename = path.join(directory, 'synthetic.sqlite')
    let store,
        game,
        session,
        client,
        seq = 1
    const state = () => store.load(session.id).state
    t.after(() => {
        store?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const send = (name, request = {}, sequence = seq++) => {
        const entry = protocol.byName.get('CSProto' + name)
        const frame = { id: entry.id, seq: sequence, payload: protocol.encode(entry.req, request) }
        const packets = game.dispatch(session, frame)
        client.consumePackets(packets)
        return { frame, packets }
    }
    const login = () => {
        session = {}
        client = new ObtInventoryConsumer(tables, protocol)
        return send('EnterGame', { open_id: 'soul-flow-current-' + name })
    }
    const reopen = () => {
        store?.close()
        store = new Store(filename)
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
        return login()
    }
    reopen()
    assert.equal(state().starterProfile.mode, 'normal')
    assert.equal(state().player.soulessence_infos.soulessences.length, 0)
    const grant = (rewards) =>
        send('GMCommands', {
            cmds: rewards.map(({ itemtype, itemid, itemnum }) => ({
                command: Buffer.from(`give ${itemtype} ${itemid} ${itemnum}`).toString('base64'),
            })),
        })
    const soul = (guid) => state().player.soulessence_infos.soulessences.find((item) => item.guid === guid)
    const view = (name, request, verify) => {
        let called = false
        client.onAck(name, (_cache, response) => {
            verify(response)
            called = true
        })
        const result = send(name, request)
        assert(called, 'Actual current request ACK callback did not run')
        return result
    }
    return {
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        get client() {
            return client
        },
        state,
        soul,
        send,
        grant,
        view,
        reopen,
    }
}
function expectedModule(item) {
    if (!item) return { attrs: [], skills: [] }
    const config = tables.find('soulessence', item.id),
        value = tables.find('soulessence_value', config.attribute * 1000 + item.lv)
    assert(value)
    const rank = tables.get('soulessence_rank').find((row) => row.relatedId === item.id && row.rank === item.rank)
    assert.equal(rank.rankUpAttributeAll, '', 'Current ordinary rank bands do not add phantom rank stats')
    const attrs = String(value.baseAttribute)
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [id, val] = token.split('#').map(Number)
            return { attr_id: id, attr_val: String(val * ([1, 3, 5, 201, 229, 230].includes(id) ? 10000 : 1)) }
        })
        .sort((a, b) => a.attr_id - b.attr_id)
    const selected = new Map()
    for (const row of tables
        .get('soulessence_grade')
        .filter((row) => row.soulessenceId === item.id && row.grade <= item.advance - 1))
        if (!selected.has(row.subSkillId) || selected.get(row.subSkillId).grade < row.grade)
            selected.set(row.subSkillId, row)
    const skills = [...selected.values()]
        .sort((a, b) => a.subSkillId - b.subSkillId)
        .map((row) => ({ skill_id: row.skillId, skill_lv: row.skillLv }))
    return { attrs, skills }
}
function cachedEquipment(f, heroGuid, item) {
    const wire = f.client.equipment(heroGuid),
        sub = wire.modules.find((module) => module.module_type === 1).sub_modules[0],
        expected = expectedModule(item)
    assert.deepEqual(sub.attrs.attrs, expected.attrs)
    assert.deepEqual(
        sub.skills.skills.map(({ skill_id, skill_lv }) => ({ skill_id, skill_lv })),
        expected.skills,
    )
    if (item) {
        const cached = f.client.souls.get(String(item.guid))
        for (const key of ['id', 'lv', 'rank', 'advance', 'exp', 'lock', 'wear_hero'])
            assert.equal(cached[key], item[key], `Incomplete current essence cache field ${key}`)
    }
}
function prepare(f) {
    f.grant([
        { itemtype: 1, itemid: heroId, itemnum: 1 },
        { itemtype: 9, itemid: soulId, itemnum: 2 },
    ])
    const hero = f.state().player.heros_info.heros.find((hero) => hero.conf_id === heroId),
        [target, donor] = f.state().player.soulessence_infos.soulessences
    assert.equal(f.state().player.soulessence_infos.soulessences.length, 2)
    assert.notEqual(target.guid, donor.guid)
    return { hero, target, donor }
}
const reject = (f, fn, code) => {
    const before = f.store.load(f.session.id),
        logs = f.store.db.prepare('SELECT * FROM request_log').all()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
}

test('current77 catalog has real100 level attributes and five refinement skill tiers, without legacy numeric override', () => {
    const configs = tables.get('soulessence')
    assert(configs.length > 0)
    for (const config of configs) {
        const before = structuredClone(config)
        const curve = tables.get('soulessence_level').filter((row) => row.rarity === config.rarity),
            cap = Math.max(
                ...tables
                    .get('soulessence_rank')
                    .filter((row) => row.relatedId === config.id)
                    .map((row) => row.rankLevelLimit),
            )
        assert.deepEqual(
            curve.map((row) => row.lv).sort((a, b) => a - b),
            Array.from({ length: cap }, (_, i) => i + 1),
        )
        for (const row of curve) {
            const value = tables.find('soulessence_value', config.attribute * 1000 + row.lv)
            assert(value?.baseAttribute, `${config.id}:${row.lv}`)
        }
        for (let grade = 0; grade < Number(setting('SOULESSENCE_MAX_GRADE')); grade++)
            assert(
                tables.get('soulessence_grade').some((row) => row.soulessenceId === config.id && row.grade === grade),
            )
        assert.equal(config.gradeItem, 0)
        assert.deepEqual(config, before)
    }
    assert.equal(protocol.byName.has('CSProtoRankUpSoulEssence'), false)
})

test('normal owned producer ->6046 ->paid6047 ->protected6048/6050 ->full attributes ->unequip and SQLite reopen', (t) => {
    const f = fixture(t, 'level-refine'),
        { hero, target, donor } = prepare(f)
    f.view('MoveSoulEssence', { hero_id: hero.guid, guid: target.guid }, () =>
        cachedEquipment(f, hero.guid, f.soul(target.guid)),
    )
    const curve = tables
        .get('soulessence_level')
        .filter((row) => row.rarity === tables.find('soulessence', soulId).rarity)
    const qty = Math.max(
        1,
        Math.ceil((curve.find((row) => row.lv === 2).exp_all - curve.find((row) => row.lv === 1).exp_all) / expPerItem),
    )
    f.grant([
        { itemtype: 3, itemid: material, itemnum: qty },
        { itemtype: 10, itemid: 2, itemnum: goldPerItem * qty + 17 },
    ])
    const before = structuredClone(f.state())
    f.view('ComposeSoulEssence', { guid: target.guid, cost_items: [{ id: material, num: qty }] }, () =>
        cachedEquipment(f, hero.guid, f.soul(target.guid)),
    )
    assert.equal(amount(f.state(), material), amount(before, material) - qty)
    assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold - goldPerItem * qty)
    const upgraded = f.soul(target.guid),
        total = curve.find((row) => row.lv === 1).exp_all + expPerItem * qty
    assert(upgraded.lv >= 2)
    assert.equal(curve.find((row) => row.lv === upgraded.lv).exp_all + upgraded.exp, total)
    // A second business call is another upgrade, not a transport retry. The
    // server's ReplayWindow sits outside Game.dispatch. With no paid materials
    // left, a new request must fail atomically instead of granting free XP.
    reject(
        f,
        () => f.send('ComposeSoulEssence', { guid: target.guid, cost_items: [{ id: material, num: qty }] }),
        ErrorCode.ItemNotEnough,
    )
    reject(
        f,
        () => f.send('RisingStarSoulEssence', { guid: target.guid, guids: [donor.guid] }),
        ErrorCode.SoulEssenceCostLock,
    )
    f.send('SetLockSoulEssence', { guids: [donor.guid], lock: false })
    assert.equal(f.client.souls.get(String(donor.guid)).lock, false)
    const oldTarget = structuredClone(f.soul(target.guid)),
        gold = f.state().player.basic_info.gold
    f.view('RisingStarSoulEssence', { guid: target.guid, guids: [donor.guid] }, () => {
        cachedEquipment(f, hero.guid, f.soul(target.guid))
        assert(!f.client.souls.has(String(donor.guid)))
    })
    assert.deepEqual(f.soul(target.guid), { ...oldTarget, advance: oldTarget.advance + 1 })
    assert.equal(f.state().player.basic_info.gold, gold)
    reject(
        f,
        () => f.send('RisingStarSoulEssence', { guid: target.guid, guids: [donor.guid] }),
        ErrorCode.SoulEssenceCostNotEnough,
    )
    f.view('MoveSoulEssence', { hero_id: hero.guid, guid: 0 }, () => cachedEquipment(f, hero.guid, null))
    assert.equal(f.soul(target.guid).wear_hero, '0')
    const saved = structuredClone(f.soul(target.guid)),
        bag = structuredClone(f.state().player.sbag_infos),
        allocator = f.state().nextEssenceGuid
    f.reopen()
    assert.deepEqual(f.soul(target.guid), saved)
    assert.deepEqual(f.state().player.sbag_infos, bag)
    assert.equal(f.state().nextEssenceGuid, allocator)
    assert(!f.soul(donor.guid))
    cachedEquipment(f, hero.guid, null)
})

test('current lock/equipped/decompose protection, exact refund and response/SQL failures preserve complete instances', (t) => {
    const f = fixture(t, 'protection-rollback'),
        { hero, target, donor } = prepare(f)
    f.grant([
        { itemtype: 3, itemid: material, itemnum: 1 },
        { itemtype: 10, itemid: 2, itemnum: goldPerItem + 17 },
    ])
    reject(f, () => f.send('DecomposeSoulEssence', { guids: [donor.guid] }), ErrorCode.LockSoulEssence)
    f.send('SetLockSoulEssence', { guids: [donor.guid], lock: false })
    f.send('MoveSoulEssence', { hero_id: hero.guid, guid: donor.guid })
    reject(f, () => f.send('ComposeSoulEssence', { guid: target.guid, costs: [donor.guid] }), ErrorCode.WearSoulEssence)
    reject(f, () => f.send('DecomposeSoulEssence', { guids: [donor.guid] }), ErrorCode.SoulEssenceOnWear)
    f.send('MoveSoulEssence', { hero_id: hero.guid, guid: 0 })
    const request = { guid: target.guid, cost_items: [{ id: material, num: 1 }] },
        before = f.store.load(f.session.id),
        encode = protocol.encode
    protocol.encode = function (name, value) {
        if (name === 'cs.Rewards') throw Error('current-soul-codec')
        return encode.call(this, name, value)
    }
    try {
        assert.throws(() => f.send('ComposeSoulEssence', request), /current-soul-codec/)
    } finally {
        protocol.encode = encode
    }
    assert.deepEqual(f.store.load(f.session.id), before)
    f.store.db.exec(
        "CREATE TEMP TRIGGER soul_sql_failure BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'current-soul-sql'); END",
    )
    try {
        assert.throws(() => f.send('ComposeSoulEssence', request), /current-soul-sql/)
    } finally {
        f.store.db.exec('DROP TRIGGER soul_sql_failure')
    }
    assert.deepEqual(f.store.load(f.session.id), before)
    f.send('ComposeSoulEssence', request)
    const expected = String(tables.find('soulessence', donor.id).decomposed)
        .split('|')
        .map((token) => {
            const [itemtype, itemid, itemnum] = token.split('#').map(Number)
            return { itemtype, itemid, itemnum }
        })
    const counts = new Map(expected.filter((r) => r.itemtype === 3).map((r) => [r.itemid, amount(f.state(), r.itemid)]))
    f.view('DecomposeSoulEssence', { guids: [donor.guid] }, (response) => {
        assert.deepEqual(
            response.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            expected,
        )
        assert(!f.client.souls.has(String(donor.guid)))
        for (const r of expected.filter((r) => r.itemtype === 3))
            assert.equal(f.client.count(r.itemid), counts.get(r.itemid) + r.itemnum)
    })
    reject(f, () => f.send('DecomposeSoulEssence', { guids: [donor.guid] }), ErrorCode.SoulEssenceNotExist)
    const saved = f.state().player.soulessence_infos.soulessences
    f.reopen()
    assert.deepEqual(f.state().player.soulessence_infos.soulessences, saved)
})
