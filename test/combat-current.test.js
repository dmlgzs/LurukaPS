import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { createPets } from '../src/pets.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { completedEnemyGroup } from '../src/enemy-group-completion.js'
import { playerIsInBattle } from '../src/player-battle-state.js'
import { boundedSet, combatState } from '../src/combat-state.js'
import { activateCombatGroup, combatEntityStates } from '../src/combat-enemy-lifecycle.js'
import { visibleEnemySlots } from '../src/enemy-group-visibility.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { ErrorCode } from '../src/error-codes.js'
import { worldSync } from '../src/handlers/world.js'
import { optimizeSyncPackets } from '../src/sync-delta.js'
import { replayCombatEnemyTerminals, publishCombatEnemyActivations } from '../src/handlers/world-combat.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    let now = 1800000000
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1,
        hero,
        pet,
        ids
    const call = (name, data = {}, target = session) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e, name)
        return game.dispatch(target, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: 'current-combat' })
    store.transact(session.id, 0, (state) => {
        state.tasks = []
        const manager = state.player.group_mgrs.find((row) => row.type === 1),
            formation = manager.groups.find((row) => row.id === manager.cur_group)
        hero = formation.control
        pet = createPets(tables, state, 500001, 1)[0].guid
        state.pets.find((row) => row.guid === pet).hero_id = hero
        const slot = formation.heros.find((row) => row.hero_id === hero)
        if (slot) slot.pet_id = pet
        const root = (7n << 56n) | 912346n
        ids = [0n, 1n, 2n].map((slot) => (root | (slot << 32n)).toString())
        let found = false
        for (const pack of tables.get('enemy_pack')) {
            if (pack.ECampType === 2 || pack.specialCreateType === 1) continue
            state.playableEnemies = {
                [state.world.map_id + ':912346']: {
                    created_at: now,
                    config_fingerprint: createHash('sha256')
                        .update(JSON.stringify([pack.id, pack.id, pack.id]))
                        .digest('hex'),
                    entities: ids.map((uuid) => ({ uuid, config_id: pack.id, container: 912346 })),
                },
            }
            if (ids.every((id) => enemyDefinition(tables, state, id))) {
                found = true
                break
            }
        }
        assert(found, 'actual current enemy pack has complete battle properties')
    })
    const state = () => store.load(session.id).state
    const hit = (source, target, change, timestamp = String(now * 1000)) =>
        call('BattleInfoReduce', {
            base_time: timestamp,
            uint64_dic: [source, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: change } }],
        })
    const activate = (scopeKey, active = true) =>
        store.transact(session.id, 0, (s) => {
            combatState(s, now)
            const packIds = ids.map((id) => enemyDefinition(tables, s, id).pack_id)
            return activateCombatGroup(s, {
                root: ids[0],
                scopeKey,
                packIds,
                active,
                activatedAtMs: now * 1000,
                adoptExisting: true,
            })
        })
    return {
        store,
        game,
        session,
        call,
        state,
        hit,
        hero,
        pet,
        ids,
        activate,
        now: () => now,
        advance: (seconds) => (now += seconds),
    }
}

function fixedWorldGroup(f) {
    let result
    f.store.transact(f.session.id, 0, (state) => {
        for (const file of fs.readdirSync(tables.dir).filter((name) => /^worldmap_\d+\.json$/.test(name))) {
            const map = Number(file.match(/\d+/)[0])
            if (tables.find('world_city', map)?.type !== 1) continue
            state.world.map_id = map
            for (const row of tables.get(file.slice(0, -5))) {
                if (tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
                const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                    .split('|')
                    .filter(Boolean)
                    .map(Number)
                if (
                    !packs.length ||
                    packs.length > 24 ||
                    packs.some((id) => {
                        const pack = tables.find('enemy_pack', id)
                        return !pack || pack.specialCreateType === 1 || pack.ECampType === 2
                    })
                )
                    continue
                const root = (3n << 56n) | BigInt(row.id),
                    ids = packs.map((_, slot) => (root | (BigInt(slot) << 32n)).toString())
                if (
                    !ids.every((id) => {
                        const d = enemyDefinition(tables, state, id)
                        return d?.max_hp > 1 && d.max_hp <= 0x7fffffff
                    })
                )
                    continue
                result = ids
                delete state.world.scene_transition
                delete state.world.loaded_at
                state.world.client_loaded = false
                return
            }
        }
        assert(result, 'current fixed-world group is available')
    })
    return result
}

test('current hero and pet final blows publish alive-state and killer before hurt callbacks and clear the whole completed wave', () => {
    const f = fixture()
    try {
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: f.ids[0], target_obj_ids: [f.hero], player_obj_ids: [f.session.id] },
        })
        f.call('PlayerHatredIncSync', { inc: true, info: { id: String(f.session.id), target_obj_ids: f.ids } })
        assert(playerIsInBattle(f.state()))
        for (const [index, id] of f.ids.entries()) {
            const source = index === 1 ? f.pet : f.hero,
                definition = enemyDefinition(tables, f.state(), id)
            const packets = f.hit(source, id, -definition.max_hp)
            const alive = packets.find((row) => row.id === 10009)
            assert(alive, 'current EntityService10009 packet')
            const info = protocol
                .decode(protocol.byId.get(10009).rsp, alive.payload)
                .infos.find((row) => row.uuid === id)
            assert.equal(info.hp, 0)
            assert.equal(info.alive_state, 1)
            assert.equal(info.final_blow_guid, source)
            assert(packets.indexOf(alive) < packets.findIndex((row) => row.id === 10706))
            assert.equal(!!completedEnemyGroup(tables, f.state(), id), index === 2)
        }
        assert(!playerIsInBattle(f.state()))
        assert.deepEqual(f.state().combat.hatred, { objects: {}, players: {} })
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: f.ids[0], target_obj_ids: [f.hero], player_obj_ids: [f.session.id] },
        })
        assert(!playerIsInBattle(f.state()), 'late stale hatred cannot reopen a completed wave')
        const killer = f.state().combat.entities[f.ids[1]].final_blow_guid
        f.hit(f.hero, f.ids[1], -1)
        assert.equal(f.state().combat.entities[f.ids[1]].final_blow_guid, killer)
    } finally {
        f.store.close()
    }
})

test('authoritative activation generations preserve a same-wave rebuild but permit same-UID same-pack reactivation and reject older frames', () => {
    const f = fixture()
    try {
        const initial = f.activate('independent-run:1:wave:1')
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        const deadTime = String(f.now() * 1000)
        const repeated = f.activate('independent-run:1:wave:1')
        assert.equal(repeated.generation, initial.generation)
        assert.equal(f.state().combat.entities[f.ids[0]].hp, 0)
        const roster = f.ids.map((uid) => ({
            uid,
            enemy_pack: enemyDefinition(tables, f.state(), uid).pack_id,
            hp: 999,
            alive_state: 0,
        }))
        assert.deepEqual(visibleEnemySlots(roster, combatEntityStates(f.state().combat)), [])
        f.activate('independent-run:1:wave:1', false)
        f.hit(f.hero, f.ids[0], -1)
        assert.equal(f.state().combat.entities[f.ids[0]].hp, 0, 'inactive generations do not consume late damage')
        f.advance(2)
        const reactivated = f.activate('independent-run:1:wave:1', true)
        assert(reactivated.generation > initial.generation)
        assert.deepEqual(visibleEnemySlots(roster, combatEntityStates(f.state().combat)), [0, 1, 2])
        f.hit(f.hero, f.ids[0], -1, deadTime)
        assert.equal(f.state().combat.entities[f.ids[0]], undefined)
        f.hit(f.hero, f.ids[0], -1)
        assert(f.state().combat.entities[f.ids[0]].hp > 0)
        const restarted = f.activate('independent-run:2:wave:1')
        assert(restarted.generation > reactivated.generation, 'a separately admitted retry has its own identity')
        assert.equal(f.state().combat.enemyTerminals?.[f.ids[0]], undefined)
        f.advance(2)
        f.hit(f.hero, f.ids[0], -1)
        assert(f.state().combat.entities[f.ids[0]].hp > 0)
    } finally {
        f.store.close()
    }
})

test('a replacement enemy pack cannot inherit an older pack death and a fresh login does not reset a confirmed same-run death', () => {
    const f = fixture()
    try {
        f.activate('independent-run:1:wave:1')
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        const generation = f.state().combat.enemyActivations[f.ids[0]].generation
        const oldTime = String(f.now() * 1000)
        f.call('EnterGame', { open_id: 'current-combat' }, {})
        assert.equal(f.state().combat.enemyActivations[f.ids[0]].generation, generation)
        assert.equal(combatEntityStates(f.state().combat)[f.ids[0]].hp, 0)
        f.advance(2)
        const oldPack = f.state().combat.entities[f.ids[0]].pack_id
        f.store.transact(f.session.id, 0, (state) => {
            const entry = Object.values(state.playableEnemies)[0]
            let replacement
            for (const row of tables.get('enemy_pack')) {
                if (row.id === oldPack || row.ECampType === 2 || row.specialCreateType === 1) continue
                for (const item of entry.entities) item.config_id = row.id
                if (f.ids.every((id) => enemyDefinition(tables, state, id))) {
                    replacement = row.id
                    break
                }
            }
            assert(replacement, 'a different valid actual pack is available')
        })
        f.hit(f.hero, f.ids[0], -1, oldTime)
        assert.equal(
            f.state().combat.entities[f.ids[0]],
            undefined,
            'old-pack late damage cannot initialize a replacement body',
        )
        f.hit(f.hero, f.ids[0], -1)
        const current = f.state().combat.entities[f.ids[0]]
        assert.notEqual(current.pack_id, oldPack)
        assert(current.hp > 0)
        assert.equal(current.final_blow_guid, undefined)
        assert(f.state().combat.enemyActivations[f.ids[0]].generation > generation)
    } finally {
        f.store.close()
    }
})

test('a codec exception after death cannot leak terminal maps through the deferred combat fork', () => {
    const f = fixture(),
        original = protocol.encode
    try {
        f.hit(f.pet, f.ids[0], -enemyDefinition(tables, f.state(), f.ids[0]).max_hp)
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id)
        protocol.encode = function (name, value) {
            if (name.endsWith('SCObjBattleInfoSync') && value.infos?.some((row) => row.uuid === f.ids[1]))
                throw Error('injected-current-combat-codec')
            return original.call(this, name, value)
        }
        assert.throws(
            () =>
                f.hit(
                    f.hero,
                    f.ids[1],
                    -enemyDefinition(tables, f.state(), f.ids[1]).max_hp,
                    String(f.now() * 1000 + 500),
                ),
            /injected-current-combat-codec/,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.state().combatReportHighWaterMs, before.combatReportHighWaterMs)
        assert.equal(f.store.pending.get(f.session.id), pending)
    } finally {
        protocol.encode = original
        f.store.close()
    }
})

test('combat report high-water migration is strict and only fixes a barrier for a genuinely new runtime', () => {
    const state = {
        world: { map_id: 101 },
        combat: { map_id: 101, bullets: {}, last_base_time: '1800000000500' },
    }
    const old = combatState(state, 1800000000)
    assert.equal(state.combatReportHighWaterMs, '1800000000500')
    assert.equal(old.runtimeActivatedAtMs, '0', 'adopting an old live runtime preserves its baseline')
    delete state.combat
    const fresh = combatState(state, 1800000000)
    assert.equal(fresh.runtimeActivatedAtMs, '1800000000501')
    state.combatReportHighWaterMs = '1800000000900'
    assert.equal(combatState(state, 1800000000).runtimeActivatedAtMs, '1800000000501')
    for (const invalid of [null, 0, -1, '01', '-1', '', '18446744073709551616']) {
        assert.throws(
            () => combatState({ world: { map_id: 101 }, combatReportHighWaterMs: invalid }, 1800000000),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
    assert.throws(
        () => combatState({ world: { map_id: 101 }, combatReportHighWaterMs: '18446744073709551615' }, 1800000000),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('same-runtime first observation of a second real group accepts another packet at the same millisecond', () => {
    const f = fixture()
    try {
        const timestamp = String(f.now() * 1000 + 500)
        f.hit(f.hero, f.ids[0], -1, timestamp)
        let second
        f.store.transact(f.session.id, 0, (state) => {
            const first = Object.values(state.playableEnemies)[0],
                root = (7n << 56n) | 912347n
            second = root.toString()
            state.playableEnemies[state.world.map_id + ':912347'] = {
                ...first,
                entities: first.entities.map((row, slot) => ({
                    ...row,
                    uuid: (root | (BigInt(slot) << 32n)).toString(),
                    container: 912347,
                })),
            }
        })
        const definition = enemyDefinition(tables, f.state(), second)
        f.hit(f.hero, second, -1, timestamp)
        assert.equal(f.state().combat.entities[second].hp, definition.max_hp - 1)
        assert.equal(f.state().combatReportHighWaterMs, timestamp)
    } finally {
        f.store.close()
    }
})

test('current skill start/stop fields retain uint64 provenance and complete both hero and pet casts', () => {
    const f = fixture()
    try {
        const owned = f.state().pets.find((row) => row.guid === f.pet)
        const heroConfig = tables.find(
            'hero',
            f.state().player.heros_info.heros.find((row) => row.guid === f.hero).conf_id,
        )
        const heroSkill = Number(heroConfig.skillList.split('|')[0].split('#')[1])
        for (const [id, skill] of [
            [f.hero, heroSkill],
            [f.pet, owned.inherent_skills[0].skill_id],
        ]) {
            f.call('SkillStart', {
                unit_id: id,
                skill: { skill_id: skill, slot: 1 },
                op_time: '9007199254740993',
                verify_info: { source_type: 1, battle_index: '9007199254740994' },
            })
            assert.equal(f.state().combat.skills[id].op_time, '9007199254740993')
            f.call('SkillStop', {
                unit_id: id,
                skill_id: String(skill),
                op_time: '9007199254740995',
                verify_info: { source_type: 1, related_index: '9007199254740994' },
            })
            assert.equal(f.state().combat.skills[id], undefined)
        }
    } finally {
        f.store.close()
    }
})

test('a late hit cannot resurrect a completed-wave corpse after bounded combat-cache eviction', () => {
    const f = fixture()
    try {
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        f.store.transact(f.session.id, 0, (state) => {
            for (let i = 0; i < 513; i++)
                boundedSet(
                    state.combat.entities,
                    ((7n << 56n) | BigInt(990000 + i)).toString(),
                    { uuid: ((7n << 56n) | BigInt(990000 + i)).toString(), reported_attributes: [] },
                    512,
                )
        })
        assert.equal(
            f.state().combat.entities[f.ids[0]],
            undefined,
            'the same bounded cache used by attribute reports evicts the old corpse',
        )
        f.hit(f.hero, f.ids[0], -1)
        const restored = f.state().combat.entities[f.ids[0]]
        assert.equal(restored.hp, 0)
        assert.equal(restored.alive_state, 1)
        assert.equal(restored.final_blow_guid, f.pet)
        const frames = []
        const replay = { state: f.state(), tables, pushBefore: (name, value) => frames.push({ name, value }) }
        assert.equal(replayCombatEnemyTerminals(replay), 3)
        const payload = frames.flatMap(
            (frame) =>
                protocol.decode('cs.SCObjBattleInfoSync', protocol.encode('cs.SCObjBattleInfoSync', frame.value)).infos,
        )
        assert(payload.every((info) => info.hp === 0 && info.alive_state === 1 && info.final_blow_guid === f.pet))
        f.advance(2)
        f.activate('independent-new-admission')
        assert.equal(replayCombatEnemyTerminals({ ...replay, state: f.state() }), 0)
    } finally {
        f.store.close()
    }
})

test('fixed-world deaths survive hot-cache eviction but the existing authoritative combat-runtime recreation admits a fresh same-UID encounter', () => {
    const f = fixture(),
        original = protocol.encode
    try {
        const ids = fixedWorldGroup(f)
        assert(ids?.length)
        for (const id of ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        const epoch = f.state().combat.runtimeEpoch
        assert(f.state().combat.enemyActivations[ids[0]].scopeKey.startsWith(`runtime:${epoch}:`))
        f.store.transact(f.session.id, 0, (state) => {
            for (let index = 0; index < 513; index++) {
                const key = ((7n << 56n) | BigInt(880000 + index)).toString()
                boundedSet(state.combat.entities, key, { uuid: key, reported_attributes: [] }, 512)
            }
        })
        f.hit(f.hero, ids[0], -1)
        assert.equal(f.state().combat.entities[ids[0]].hp, 0)
        // Current admitted fresh-instance/map reset paths delete combat.
        // Recreating that exact runtime, unlike a mere snapshot, is a new epoch.
        f.store.transact(f.session.id, 0, (state) => {
            delete state.combat
        })
        f.hit(f.hero, ids[0], -1)
        assert(f.state().combat.runtimeEpoch > epoch)
        assert.equal(f.state().combat.entities[ids[0]], undefined, 'same-time old report cannot initialize new runtime')
        f.advance(1)
        f.hit(f.hero, ids[0], -1)
        assert(f.state().combat.entities[ids[0]].hp > 0)
        assert.equal(f.state().combat.entities[ids[0]].final_blow_guid, undefined)
        f.store.transact(f.session.id, 0, (state) => {
            delete state.combat
        })
        const before = structuredClone(f.state())
        f.advance(1)
        protocol.encode = function (name, value) {
            if (name.endsWith('SCObjBattleInfoSync') && value.infos?.some((row) => row.uuid === ids[0]))
                throw Error('injected-epoch-codec')
            return original.call(this, name, value)
        }
        assert.throws(() => f.hit(f.hero, ids[0], -1), /injected-epoch-codec/)
        assert.deepEqual(f.state(), before, 'runtime epoch allocation rolls back with the failed deferred report')
    } finally {
        protocol.encode = original
        f.store.close()
    }
})

test('actual direct task-enemy provenance uses the existing local epoch0 baseline, current task epoch and strict corrupt-value checks', () => {
    const f = fixture(),
        id = ((4n << 56n) | 102056n).toString()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.world.map_id = 102
            state.tasks = [{ task_id: 106002, nodes: [{ node_id: 56 }] }]
            state.taskEpochs ??= {}
            delete state.taskEpochs[106002]
        })
        const baseline = enemyDefinition(tables, f.state(), id)
        assert(baseline?.activation_source, 'the actual current direct-node source is resolved')
        assert.equal(baseline.activation_source.task_id, 106002)
        assert.equal(baseline.activation_source.task_epoch, 0)
        f.store.transact(f.session.id, 0, (state) => {
            state.taskEpochs[106002] = 1
        })
        const current = enemyDefinition(tables, f.state(), id)
        assert.equal(current.activation_source.task_epoch, 1)
        assert.equal(current.activation_source.owner_id, baseline.activation_source.owner_id)
        f.store.transact(f.session.id, 0, (state) => {
            state.taskEpochs[106002] = -1
        })
        assert.throws(
            () => enemyDefinition(tables, f.state(), id),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('fresh activation clears client hp0/killer sync fields and its publisher is isolated even under a shallow deferred fork', () => {
    const f = fixture()
    try {
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        f.advance(2)
        f.activate('independent-fresh-admission')
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id)
        assert.throws(
            () =>
                f.store.transact(
                    f.session.id,
                    0,
                    (state) => {
                        publishCombatEnemyActivations({
                            state,
                            tables,
                            now: f.now(),
                            pushBefore: () => {
                                throw Error('injected-activation-codec')
                            },
                        })
                    },
                    { defer: true, fork: (base) => ({ ...base }) },
                ),
            /injected-activation-codec/,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        const frames = []
        f.store.transact(f.session.id, 0, (state) => {
            const context = {
                state,
                tables,
                now: f.now(),
                pushBefore: (name, value) => {
                    const entry = protocol.byName.get(name)
                    frames.push(protocol.decode(entry.rsp, protocol.encode(entry.rsp, value)))
                },
            }
            assert.equal(publishCombatEnemyActivations(context), 3)
            assert.equal(replayCombatEnemyTerminals(context), 0)
        })
        const infos = frames.flatMap((frame) => frame.infos)
        assert.equal(infos.length, 3)
        for (const info of infos) {
            assert.equal(info.alive_state, 0)
            assert.equal(info.final_blow_guid, '0')
            assert.equal(info.hp, enemyDefinition(tables, f.state(), info.uuid).max_hp)
        }
    } finally {
        f.store.close()
    }
})

test('a legacy cached corpse with a different actual pack cannot poison the first versioned activation', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            const battle = combatState(state, f.now()),
                definition = enemyDefinition(tables, state, f.ids[0])
            const other = tables.get('enemy_pack').find((row) => row.id !== definition.pack_id)
            battle.entities[f.ids[0]] = {
                uuid: f.ids[0],
                ...definition,
                pack_id: other.id,
                hp: 0,
                alive_state: 1,
                final_blow_guid: f.pet,
            }
            activateCombatGroup(state, {
                root: f.ids[0],
                scopeKey: 'new-authoritative-source',
                packIds: f.ids.map((id) => enemyDefinition(tables, state, id).pack_id),
                active: true,
                activatedAtMs: f.now() * 1000,
                adoptExisting: true,
            })
            assert.equal(battle.entities[f.ids[0]], undefined)
            assert.equal(battle.enemyTerminals?.[f.ids[0]], undefined)
        })
        f.hit(f.hero, f.ids[0], -1)
        assert(f.state().combat.entities[f.ids[0]].hp > 0)
        assert.equal(f.state().combat.entities[f.ids[0]].final_blow_guid, undefined)
    } finally {
        f.store.close()
    }
})

test('the real scene-ready callback replays terminal HP even after its preceding packet was cached by the send optimizer', () => {
    const f = fixture()
    try {
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        const packets = f.call('MapLoadFinish')
        const infos = packets
            .filter((packet) => packet.id === 10009)
            .flatMap((packet) => protocol.decode(protocol.byId.get(10009).rsp, packet.payload).infos)
        for (const id of f.ids)
            assert(
                infos.some((info) => info.uuid === id && info.hp === 0 && info.alive_state === 1),
                '9151 must restore the current terminal after cold-cache rebuild',
            )
    } finally {
        f.store.close()
    }
})

test('actual same-map WorldMapSync packet generation and optimization keep post-9103 terminal replay in send order', () => {
    const f = fixture()
    try {
        for (const id of f.ids) f.hit(f.pet, id, -enemyDefinition(tables, f.state(), id).max_hp)
        const raw = []
        f.store.transact(f.session.id, 0, (state) => {
            const emit = (name, value) => {
                const entry = protocol.byName.get(name)
                raw.push({ id: entry.id, payload: protocol.encode(entry.rsp, value) })
            }
            const context = { state, tables, id: f.session.id, now: f.now(), push: emit, pushBefore: emit }
            worldSync(context, {}, 2, false)
        })
        const optimized = optimizeSyncPackets(protocol, f.session, raw, 'CSProtoMapLoadFinish')
        const map = optimized.findIndex((packet) => packet.id === 9103),
            mode = optimized.findIndex((packet) => packet.id === 11055)
        assert(map >= 0 && mode > map)
        const terminal = optimized.findIndex(
            (packet) =>
                packet.id === 10009 &&
                protocol
                    .decode(protocol.byId.get(10009).rsp, packet.payload)
                    .infos.some((info) => info.uuid === f.ids[0] && info.hp === 0),
        )
        assert(
            terminal > mode,
            'actual worldSync must replay after destination proxy selection, and the optimizer must retain it',
        )
    } finally {
        f.store.close()
    }
})
