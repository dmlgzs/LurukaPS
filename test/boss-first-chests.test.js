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
import { enemyDefinition } from '../src/enemy-state.js'
import { recordBossFirstClear } from '../src/boss-first-chests.js'
import { finishEnemyGroupRelations } from '../src/handlers/world-combat.js'
import { populateParty } from './party-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    world = new WorldObjectCatalog(tables)
const rules = tables.get('boss_first_chest_drop')
function fixture(file = ':memory:', source = tables) {
    const p = new Protocol(cfg.base),
        store = new Store(file, { flushIntervalMs: 60000 })
    const game = new Game(p, store, source, { clock: () => 1800000000, rng: (a, b) => (b === undefined ? 0 : a) })
    let session = {},
        seq = 1
    const call = (name, data = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, data) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'boss-first-chests' })
    }
    const login = reload()
    store.transact(session.id, 0, (s) => {
        populateParty(s)
        s.tasks = []
        s.taskRecords = source.get('task').map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        delete s.storyCampaign
        delete s.entrust?.run
        delete s.multiCampaign
        delete s.cultTrial
    })
    const state = () => store.load(session.id).state
    const enter = (rule = rules[0]) => {
        const [map, id] = rule.WorldFilter.split('|').map(Number)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = map
            s.world.pos = { ...world.object(map, id).pos }
            s.worldObjects = {}
            delete s.combat
        })
        return ((3n << 56n) | BigInt(id)).toString()
    }
    const kill = (uuid, pet = false) => {
        const s = state(),
            definition = enemyDefinition(source, s, uuid)
        assert(definition, 'Current configured boss must have a real enemy definition')
        const actor = pet ? s.pets[0].guid : s.player.heros_info.heros[0].guid
        return call('BattleInfoReduce', {
            uint64_dic: [actor, uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -definition.max_hp } }],
        })
    }
    return {
        p,
        store,
        game,
        call,
        login,
        reload,
        state,
        enter,
        kill,
        get session() {
            return session
        },
        edit: (fn) => store.transact(session.id, 0, fn),
        claim: (id = 101) => call('WorldBossChestGetReq', { u32: id }),
        close: () => store.close(),
    }
}
const ack = (out) => out.find((p) => p.id === 9122).data
const amount = (state, id) => state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0'
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('all 26 current first-chest bindings unlock only on real configured boss deaths and deliver their actual drops once', () => {
    const f = fixture()
    try {
        assert.equal(rules.length, 26)
        assert.deepEqual(f.login.find((p) => p.id === 9121).data.chest_infos, [])
        for (const rule of rules) {
            const uuid = f.enter(rule)
            const out = f.kill(uuid)
            assert(
                out.some(
                    (p) => p.id === 9121 && p.data.chest_infos.some((i) => i.chest_id === rule.id && i.state === false),
                ),
            )
            assert.equal(f.state().bossFirstChests[rule.id].received, false)
            const before = f.state(),
                paid = f.claim(rule.id),
                reply = ack(paid)
            assert.equal(reply.src, 151)
            assert(reply.rewards.length > 0)
            assert.equal(f.state().bossFirstChests[rule.id].received, true)
            const ornament = reply.rewards.find((r) => r.itemtype === 15)
            assert(ornament?.guid)
            assert(f.state().ornaments.some((o) => String(o.guid) === ornament.guid && o.id === ornament.itemid))
            const stored = f.state().ornaments.find((o) => String(o.guid) === ornament.guid)
            const customId = world.get('drop').find((d) => d.dropId === rule.drop && d.type === 33).itemId
            const custom = tables.find('accessory_customed', customId)
            assert.equal(stored.grade, custom.grade)
            assert.equal(stored.score, custom.score)
            assert(
                String(custom.quality)
                    .split('|')
                    .some((token) => Number(token.split('#')[0]) === stored.quality),
            )
            assert.equal(amount(f.state(), 3), amount(before, 3), 'First-clear reward does not spend stamina')
            assertSyncBefore(f.p, paid, 'CSProtoSyncPlayerData', 9122)
            assertSyncBefore(f.p, paid, 'CSProtoUpdateOrnament', 9122)
            assert(
                paid.findIndex((p) => p.id === 9121) > paid.findIndex((p) => p.id === 9122),
                'Received status must not destroy the interaction entity before reward callback',
            )
            assert(f.state().player.basic_info.diamond > before.player.basic_info.diamond)
            const after = f.state()
            assert.deepEqual(ack(f.claim(rule.id)).rewards, [])
            assert.equal(f.state().player.basic_info.diamond, after.player.basic_info.diamond)
            assert.equal(f.state().ornaments.length, after.ornaments.length)
        }
    } finally {
        f.close()
    }
})

test('pet last hits unlock the same chest; repeated dead reports neither recredit nor write combat progress immediately', () => {
    const f = fixture()
    try {
        const uuid = f.enter(),
            changes = f.store.db.prepare('select total_changes() n').get().n
        f.kill(uuid, true)
        assert.equal(f.state().bossFirstChests[101].received, false)
        const receipt = f.state().bossFirstChests[101]
        f.kill(uuid, true)
        assert.deepEqual(f.state().bossFirstChests[101], receipt)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, changes)
    } finally {
        f.close()
    }
})

test('central group completion can recover a genuine old death even when relation cleanup was already acknowledged', () => {
    const f = fixture()
    try {
        const uuid = f.enter()
        f.kill(uuid)
        f.edit((s) => {
            delete s.bossFirstChests
        })
        const pushed = []
        f.edit((s) =>
            finishEnemyGroupRelations(
                { tables, state: s, now: 1800000000, push: (name, data) => pushed.push({ name, data }) },
                uuid,
            ),
        )
        assert.equal(f.state().bossFirstChests[101].received, false)
        assert(pushed.some((p) => p.name === 'CSProtoWorldBossChestInfoSync'))
    } finally {
        f.close()
    }
})

test('alive bosses, completion bits without death evidence, temporary clones and wrong packs cannot grant first-clear credit', () => {
    const f = fixture()
    try {
        const uuid = f.enter(),
            definition = enemyDefinition(tables, f.state(), uuid)
        unchanged(f, () => f.claim(), ErrorCode.WorldBossChestInvalid)
        f.edit((s) => {
            s.worldObjects['100:200507'] = { obj_id: 200507, complete: true }
            s.combat = {
                map_id: 100,
                entities: { [uuid]: { ...definition, uuid, hp: 0, alive_state: 1, captured: true } },
            }
        })
        f.reload()
        assert.equal(f.state().bossFirstChests?.[101], undefined)
        f.edit((s) => {
            s.combat = { map_id: 100, entities: { [uuid]: { ...definition, uuid, hp: 0, alive_state: 1, pack_id: 1 } } }
        })
        assert.equal(recordBossFirstClear({ tables, state: f.state(), now: 1800000000, push: () => {} }, uuid), false)
        const clone = ((4n << 56n) | 200507n).toString()
        assert.equal(recordBossFirstClear({ tables, state: f.state(), now: 1800000000, push: () => {} }, clone), false)
        unchanged(f, () => f.claim(), ErrorCode.WorldBossChestInvalid)
    } finally {
        f.close()
    }
})

test('identical enemy groups in different world locations do not share a first-chest entitlement', () => {
    const pair = rules
        .flatMap((a) => rules.filter((b) => b.id > a.id).map((b) => [a, b]))
        .find(([a, b]) => {
            const [am, ao] = a.WorldFilter.split('|').map(Number),
                [bm, bo] = b.WorldFilter.split('|').map(Number)
            return am !== bm && world.object(am, ao).row.expandId === world.object(bm, bo).row.expandId
        })
    assert(pair)
    const [a, b] = pair,
        f = fixture()
    try {
        f.kill(f.enter(a))
        assert(f.state().bossFirstChests[a.id])
        assert.equal(f.state().bossFirstChests[b.id], undefined)
        unchanged(f, () => f.claim(b.id), ErrorCode.WorldBossChestInvalid)
        f.kill(f.enter(b))
        assert(f.state().bossFirstChests[b.id])
    } finally {
        f.close()
    }
})

test('claiming uses bound map and configured interaction distance and distinguishes absent configuration', () => {
    const f = fixture()
    try {
        const uuid = f.enter()
        f.kill(uuid)
        unchanged(f, () => f.claim(0xffffffff), ErrorCode.WorldBossChestConfInvalid)
        unchanged(f, () => f.claim(200507), ErrorCode.WorldBossChestConfInvalid)
        f.edit((s) => {
            s.world.map_id = 101
        })
        unchanged(f, () => f.claim(), ErrorCode.WorldBossChestInvalid)
        f.edit((s) => {
            s.world.map_id = 100
            s.world.pos = { x: 1000000, y: 1000000, z: 1000000 }
        })
        unchanged(f, () => f.claim(), ErrorCode.InteractDistanceTooFar)
        f.edit((s) => {
            s.world.pos = { ...world.object(100, 200507).pos }
        })
        assert(ack(f.claim()).rewards.length > 0)
    } finally {
        f.close()
    }
})

test('unlock notification encoding failure cannot leak a defeat receipt or HP changes from a borrowed combat base', () => {
    const f = fixture()
    try {
        const uuid = f.enter(),
            before = f.state(),
            encode = f.p.encode.bind(f.p),
            type = f.p.byName.get('CSProtoWorldBossChestInfoSync').rsp
        f.p.encode = (n, v) => {
            if (n === type) throw Error('boss unlock codec failure')
            return encode(n, v)
        }
        assert.throws(() => f.kill(uuid), /boss unlock codec failure/)
        assert.deepEqual(f.state(), before)
        f.p.encode = encode
        f.kill(uuid)
        assert.equal(f.state().bossFirstChests[101].received, false)
    } finally {
        f.close()
    }
})

test('claim reply, inventory, ornament or post-reply state failures roll back every reward and permit a once-only retry', () => {
    for (const name of [
        'CSProtoWorldBossChestGetReq',
        'CSProtoSyncPlayerData',
        'CSProtoUpdateOrnament',
        'CSProtoWorldBossChestInfoSync',
    ]) {
        const f = fixture()
        try {
            f.kill(f.enter())
            const before = f.state(),
                encode = f.p.encode.bind(f.p),
                type = f.p.byName.get(name).rsp
            f.p.encode = (n, v) => {
                if (n === type) throw Error('boss claim codec failure')
                return encode(n, v)
            }
            assert.throws(() => f.claim(), /boss claim codec failure/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
            assert(ack(f.claim()).rewards.length > 0)
            assert.deepEqual(ack(f.claim()).rewards, [])
        } finally {
            f.close()
        }
    }
})

test('a late broken ornament reward rolls back earlier currency without losing the earned chest', () => {
    let broken = false
    const customId = world.get('drop').find((d) => d.dropId === 640001 && d.type === 33).itemId
    const source = Object.create(tables)
    source.find = (n, id) => (n === 'accessory_customed' && id === customId && broken ? undefined : tables.find(n, id))
    const f = fixture(':memory:', source)
    try {
        f.kill(f.enter())
        broken = true
        unchanged(f, () => f.claim(), ErrorCode.OrnamentConfFail)
        assert.equal(f.state().bossFirstChests[101].received, false)
        broken = false
        assert(ack(f.claim()).rewards.length > 0)
        assert.deepEqual(ack(f.claim()).rewards, [])
    } finally {
        f.close()
    }
})

test('missing optional source metadata does not prevent real first-clear delivery', () => {
    const source = Object.create(tables)
    source.find = (n, id) => (n === 'reason_itemnum_change' && id === 151 ? undefined : tables.find(n, id))
    const f = fixture(':memory:', source)
    try {
        f.kill(f.enter())
        const before = f.state(),
            reply = ack(f.claim())
        assert.equal(reply.src ?? 0, 0)
        assert(reply.rewards.length > 0)
        assert(f.state().player.basic_info.diamond > before.player.basic_info.diamond)
        assert.equal(f.state().bossFirstChests[101].received, true)
    } finally {
        f.close()
    }
})

test('a legacy empty combat placeholder does not block login or fabricate any first-clear chest', () => {
    const f = fixture()
    try {
        f.enter()
        f.edit((s) => {
            s.combat = { map_id: s.world.map_id }
            delete s.bossFirstChests
        })
        const out = f.reload()
        assert.deepEqual(out.find((p) => p.id === 9121).data.chest_infos, [])
        assert.equal(f.state().bossFirstChests?.[101], undefined)
    } finally {
        f.close()
    }
})

test('login recovers retained authoritative deaths without regranting and real SQLite restart retains claim receipts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-first-chest-')),
        file = path.join(dir, 'state.sqlite')
    let f, store
    try {
        f = fixture(file)
        const uuid = f.enter()
        f.kill(uuid)
        f.edit((s) => {
            delete s.bossFirstChests
        })
        const restored = f.reload()
        assert(restored.find((p) => p.id === 9121).data.chest_infos.some((r) => r.chest_id === 101 && !r.state))
        assert.equal(f.state().bossFirstChests[101].recovered, true)
        f.claim()
        const id = f.session.id,
            before = f.state()
        f.close()
        f = undefined
        store = new Store(file)
        assert.deepEqual(store.load(id).state.bossFirstChests, before.bossFirstChests)
        const p = new Protocol(cfg.base),
            game = new Game(p, store, tables, { clock: () => 1800000000 }),
            session = {}
        for (const [name, data] of [
            ['EnterGame', { open_id: 'boss-first-chests' }],
            ['WorldBossChestGetReq', { u32: 101 }],
        ]) {
            const e = p.byName.get('CSProto' + name),
                out = game.dispatch(session, { id: e.id, seq: 1, payload: p.encode(e.req, data) })
            if (e.id === 9122) assert.deepEqual(p.decode(e.rsp, out.find((x) => x.id === e.id).payload).rewards, [])
        }
        assert.equal(store.load(id).state.player.basic_info.diamond, before.player.basic_info.diamond)
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-first-chest-'))
        fs.rmSync(dir, { recursive: true })
    }
})
