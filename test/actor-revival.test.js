import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroModules, heroBattleLimits, petModules } from '../src/battle.js'
import { populateParty } from './party-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
function fixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        populateParty(s)
        s.world.map_id = 100
        s.world.pos = { x: 123, y: 456, z: 789 }
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        sql: () => store.db.prepare('SELECT total_changes() AS n').get().n,
    }
}
const info = (f, packets) =>
    f.protocol.decode('SCObjBattleInfoSync', packets.find((p) => p.id === 10009).payload).infos[0]

test('10721 revives a real uint64 hero with actual HP, preserves SP/party/position and sends no fabricated reply', () => {
    const f = fixture('revive-hero-wire')
    try {
        const hero = f.state().player.heros_info.heros[0],
            id = hero.guid,
            max = heroBattleLimits(heroModules(f.tables, f.state(), hero)).hp
        assert(BigInt(id) > 2n ** 53n)
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.battle_infos.find((x) => x.hero_id === id)
            Object.assign(h, { hp: 0, sp: 7, alive_state: 1, rescue_val: 77, final_blow_guid: '111' })
        })
        const before = structuredClone(f.state()),
            value = Math.min(29, max),
            changes = f.sql()
        const packets = f.call('ReviveHero', { hero_uuid: id, revive_val: value })
        assert.deepEqual(
            packets.map((p) => p.id),
            [10009],
        )
        assert.deepEqual(info(f, packets), {
            uuid: id,
            hp: value,
            alive_state: 0,
            rescue_val: 0,
            final_blow_guid: '0',
            reason: 0,
        })
        const saved = f.state().player.heros_info.battle_infos.find((x) => x.hero_id === id)
        assert.equal(saved.hp, value)
        assert.equal(saved.sp, 7)
        assert.equal(saved.alive_state, 0)
        assert.equal(saved.rescue_val, 0)
        assert.equal(saved.final_blow_guid, undefined)
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.equal(f.sql(), changes)
        const second = f.call('ReviveHero', { hero_uuid: id, revive_val: max })
        assert.equal(info(f, second).hp, value)
        assert.equal(info(f, second).alive_state, 0)
        assert.equal(f.sql(), changes)
        f.store.flushPending()
        const persisted = JSON.parse(f.store.playerById.get(f.session.id).state)
        assert.equal(persisted.player.heros_info.battle_infos.find((x) => x.hero_id === id).hp, value)
    } finally {
        f.store.close()
    }
})

test('over-hurt and over-heal use the current configured HP limit without reviving or healing another hero', () => {
    const f = fixture('revive-over-hurt')
    try {
        const [hero, other] = f.state().player.heros_info.heros,
            max = heroBattleLimits(heroModules(f.tables, f.state(), hero)).hp
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(
                s.player.heros_info.battle_infos.find((x) => x.hero_id === hero.guid),
                { hp: 0, sp: 2, alive_state: 2 },
            )
            Object.assign(
                s.player.heros_info.battle_infos.find((x) => x.hero_id === other.guid),
                { hp: 0, alive_state: 1 },
            )
        })
        f.call('ReviveHero', { hero_uuid: hero.guid, revive_val: 0xffffffff })
        assert.equal(f.state().player.heros_info.battle_infos.find((x) => x.hero_id === hero.guid).hp, max)
        assert.equal(f.state().player.heros_info.battle_infos.find((x) => x.hero_id === other.guid).hp, 0)
    } finally {
        f.store.close()
    }
})

test('active temporary heroes revive in their own GUID record; retired actors never recreate a ghost', () => {
    const f = fixture('revive-trial')
    try {
        const id = ((5n << 56n) | 777n).toString()
        f.store.transact(f.session.id, 0, (s) => {
            s.trialGroup = {
                heroes: [{ ...structuredClone(s.player.heros_info.heros[0]), guid: id, trail: true }],
                pets: [],
            }
            s.player.heros_info.battle_infos.push({ hero_id: id, hp: 0, sp: 3, alive_state: 1 })
        })
        f.call('ReviveHero', { hero_uuid: id, revive_val: 4 })
        assert.equal(f.state().player.heros_info.battle_infos.find((x) => x.hero_id === id).hp, 4)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.trialGroup
            s.retiredTrialActors = [id]
            s.player.heros_info.battle_infos = s.player.heros_info.battle_infos.filter((x) => x.hero_id !== id)
        })
        const before = structuredClone(f.state())
        assert.deepEqual(f.call('ReviveHero', { hero_uuid: id, revive_val: 10 }), [])
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('owned pet AliveData is restored in the live map without changing pet SP or unrelated entities', () => {
    const f = fixture('revive-owned-pet')
    try {
        const pet = f.state().pets.find((x) => f.tables.find('template_value', x.config_id)),
            parent = f.state().player.heros_info.heros.find((x) => x.guid === pet.hero_id)
        const modules = parent ? [heroModules(f.tables, f.state(), parent)] : [],
            max = heroBattleLimits(petModules(f.tables, f.state(), pet, modules)).hp
        f.store.transact(f.session.id, 0, (s) => {
            s.combat = {
                map_id: 100,
                skills: {},
                bullets: {},
                elements: {},
                entities: {
                    [pet.guid]: { uuid: pet.guid, hp: 0, sp: 17, max_hp: max, alive_state: 1 },
                    other: { uuid: 'other', hp: 11 },
                },
                petSp: { [pet.guid]: 17 },
            }
        })
        const before = structuredClone(f.state()),
            packets = f.call('ReviveHero', { hero_uuid: pet.guid, revive_val: 5 })
        assert.equal(info(f, packets).hp, Math.min(5, max))
        assert.equal(f.state().combat.entities[pet.guid].sp, 17)
        assert.equal(f.state().combat.petSp[pet.guid], 17)
        assert.deepEqual(f.state().combat.entities.other, before.combat.entities.other)
        assert.deepEqual(f.state().pets, before.pets)
    } finally {
        f.store.close()
    }
})

test('missing actors, malformed HP, damaged battle state and authoritative arena pets fail atomically', () => {
    const f = fixture('revive-invalid')
    try {
        const base = structuredClone(f.state()),
            id = base.player.heros_info.heros[0].guid,
            pet = base.pets[0]
        const cases = [
            { r: { hero_uuid: '0', revive_val: 1 }, code: ErrorCode.InvalidArgument },
            { r: { hero_uuid: ((1n << 56n) | 0xffffffffn).toString(), revive_val: 1 }, code: ErrorCode.HeroNotExist },
            { r: { hero_uuid: ((2n << 56n) | 0xffffffffn).toString(), revive_val: 1 }, code: ErrorCode.PetNotExist },
            { r: { hero_uuid: id, revive_val: 0 }, code: ErrorCode.InvalidArgument },
            { r: { hero_uuid: id }, code: ErrorCode.InvalidArgument },
            {
                r: { hero_uuid: id, revive_val: 1 },
                change: (s) => (s.player.heros_info.battle_infos.find((x) => x.hero_id === id).hp = -1),
                code: ErrorCode.GameConfig,
            },
            {
                r: { hero_uuid: pet.guid, revive_val: 1 },
                change: (s) => (s.combat = { map_id: 100, entities: {}, npcDuel: { actors: { [pet.guid]: {} } } }),
                code: ErrorCode.FunctionClosed,
            },
        ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.change?.(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('ReviveHero', c.r),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('a failed network encoding cannot leak the revived HP through a deferred shared draft', () => {
    const f = fixture('revive-rollback'),
        original = f.game.packet
    try {
        const id = f.state().player.heros_info.heros[0].guid
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                Object.assign(
                    s.player.heros_info.battle_infos.find((x) => x.hero_id === id),
                    { hp: 0, alive_state: 1 },
                )
            },
            { defer: true },
        )
        const shared = f.state(),
            before = structuredClone(shared),
            changes = f.sql()
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('encoding failed')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('ReviveHero', { hero_uuid: id, revive_val: 3 }), /encoding failed/)
        assert.deepEqual(shared, before)
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), changes)
        f.game.packet = original
        f.call('ReviveHero', { hero_uuid: id, revive_val: 3 })
        assert.equal(f.state().player.heros_info.battle_infos.find((x) => x.hero_id === id).hp, 3)
    } finally {
        f.game.packet = original
        f.store.close()
    }
})
