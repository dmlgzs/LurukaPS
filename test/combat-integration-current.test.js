import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { combatState } from '../src/combat-state.js'
import { activateCombatGroup } from '../src/combat-enemy-lifecycle.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createPets } from '../src/pets.js'
import { optimizeSyncPackets } from '../src/sync-delta.js'
import { abyssBattlePlan } from '../src/abyss-battle-config.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { syncAbyssBattleScene } from '../src/abyss-battle.js'
import { publishCombatEnemyActivations } from '../src/handlers/world-combat.js'
import { publishCombatSceneSnapshot } from '../src/combat-scene-snapshots.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const elevator = (() => {
    const catalog = new WorldObjectCatalog(tables)
    for (const file of fs.readdirSync(tables.dir).filter((name) => /^worldmap_\d+\.json$/.test(name))) {
        const map = Number(file.match(/\d+/)[0])
        if (tables.find('world_city', map)?.type !== 1) continue
        for (const row of tables.get(file.slice(0, -5))) {
            const spawner = tables.find('world_spawner', row.spawnerId),
                blueprint = tables.find('world_blueprint', row.blueprint || spawner?.blueprint)
            if (blueprint?.path === 'Config/World/Graph/Blueprint/ast_level_pet_puzzle_chest_double_02.asset')
                return { map, ...catalog.object(map, row.id) }
        }
    }
    assert.fail('a current configured9138 blueprint source exists')
})()
function fixture(name) {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1)
            .map((row) => ({ task_id: row.id, count: 1 }))
        s.world.map_id = elevator.map
        s.world.pos = elevator.pos
        s.world.area_id = Number(String(elevator.row.worldAreaIds).split('|')[0])
        delete s.combat
    })
    const seed = (container, { capture = false, activate = true } = {}) => {
        const id = ((7n << 56n) | BigInt(container)).toString()
        edit((s) => {
            let found = false
            for (const pack of tables.get('enemy_pack')) {
                if (pack.ECampType === 2 || pack.specialCreateType === 1) continue
                const enemy = tables.find('enemy', pack.enemyId || pack.id)
                if (
                    capture &&
                    (pack.uncatchableType === 1 || !enemy?.petId || !tables.find('template_value', enemy.petId))
                )
                    continue
                s.playableEnemies ??= {}
                s.playableEnemies[s.world.map_id + ':' + container] = {
                    created_at: now,
                    config_fingerprint: createHash('sha256').update(String(pack.id)).digest('hex'),
                    entities: [{ uuid: id, config_id: pack.id, container }],
                }
                if (enemyDefinition(tables, s, id)) {
                    found = true
                    break
                }
            }
            assert(found)
            combatState(s, now)
            if (activate)
                activateCombatGroup(s, {
                    root: id,
                    scopeKey: 'integration-current:' + container,
                    packIds: [enemyDefinition(tables, s, id).pack_id],
                    activatedAtMs: now * 1000,
                })
        })
        return id
    }
    const hit = (id, delta, timestamp = String(now * 1000)) =>
        call('BattleInfoReduce', {
            base_time: timestamp,
            uint64_dic: [state().player.heros_info.heros[0].guid, id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
        })
    const database = () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id)
    return { store, session, game, call, edit, state, seed, hit, database, now: () => now, advance: () => ++now }
}
function infos(packets, id) {
    return packets.flatMap((packet, index) =>
        packet.id === 10009
            ? protocol
                  .decode(protocol.byId.get(10009).rsp, packet.payload)
                  .infos.filter((row) => !id || row.uuid === id)
                  .map((row) => ({ ...row, index }))
            : [],
    )
}

// Server integrity assertion over the actual current entry producer. The
// direct IL evidence for 9103/proxy/10009 order is in combat-current-agent.
test('actual AbyssChallengeRealStart publishes one fresh alive snapshot per actor after its dynamic9103', () => {
    const f = abyssFixture('current-combat-central-entry')
    try {
        f.call('AbyssChallenge', f.request())
        f.time.now++
        const packets = f.call('AbyssChallengeRealStart'),
            maps = packets.flatMap((packet, index) =>
                packet.id === 9103 ? [{ index, data: f.p.decode(f.p.byId.get(9103).rsp, packet.payload) }] : [],
            ),
            dynamic = maps.find((row) => row.data.cmd === 47)
        assert(dynamic, 'the actual handler emits a same-map dynamic refresh')
        const actors = f
            .state()
            .abyssRun.scene_objects.filter((row) => row.active && f.state().abyssRun.wave_objects.includes(row.obj_id))
            .flatMap((row) => row.expand_data.battle_group.monsters)
            .filter((row) => row.hp > 0)
        assert(actors.length)
        const infos = packets.flatMap((packet, index) =>
            packet.id === 10009
                ? f.p.decode(f.p.byId.get(10009).rsp, packet.payload).infos.map((info) => ({ index, ...info }))
                : [],
        )
        for (const actor of actors) {
            const alive = infos.filter((info) => info.uuid === actor.uid && info.alive_state === 0 && info.hp > 0)
            assert.equal(
                alive.length,
                1,
                'central publishing and the scene producer must not repeat the new alive actor',
            )
            assert(alive[0].index > dynamic.index)
            assert.equal(alive[0].reason, 1)
            assert.equal(alive[0].sp, 0)
            assert.equal(alive[0].final_blow_guid, '0')
        }
    } finally {
        f.store.close()
    }
})

test('actual producer initialization codec failure rolls back the new activation and a clean retry retains its reason and SP', () => {
    const f = abyssFixture('combat-central-initialization-codec'),
        original = f.p.encode
    try {
        f.call('AbyssChallenge', f.request())
        const before = structuredClone(f.state()),
            saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        f.p.encode = function (name, value) {
            if (
                name.endsWith('SCObjBattleInfoSync') &&
                value.infos?.some(
                    (row) => BigInt(row.uuid) >> 56n === 3n && row.alive_state === 0 && row.final_blow_guid === '0',
                )
            )
                throw Error('injected-planned-initialization-codec')
            return original.call(this, name, value)
        }
        assert.throws(() => f.call('AbyssChallengeRealStart'), /injected-planned-initialization-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved,
        )
        f.p.encode = original
        const packets = f.call('AbyssChallengeRealStart'),
            run = f.state().abyssRun,
            actor = Object.values(f.state().combat.entities).find((row) => run.wave_objects.includes(row.object_id)),
            rows = packets
                .filter((packet) => packet.id === 10009)
                .flatMap((packet) => f.p.decode(f.p.byId.get(10009).rsp, packet.payload).infos)
                .filter((row) => row.uuid === actor.uuid)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].reason, 1)
        assert.equal(rows[0].sp, actor.sp ?? 0)
        assert.equal(rows[0].final_blow_guid, '0')
    } finally {
        f.p.encode = original
        f.store.close()
    }
})

test('actual9138 cmd2 central publishing sends pending alive and terminal once, leaves unrelated actors and idle ticks alone', () => {
    const f = fixture('combat-central-elevator')
    try {
        const dead = f.seed(971000),
            live = f.seed(971001),
            unrelated = f.seed(971002, { activate: false })
        f.hit(dead, -enemyDefinition(tables, f.state(), dead).max_hp)
        const generation = f.state().combat.enemyActivations[dead].generation
        const packets = f.call('WorldMapTakeElevator', { obj_id: elevator.row.id, floor: 1 }),
            map = packets.findIndex((packet) => packet.id === 9103),
            mode = packets.findIndex((packet) => packet.id === 11055)
        assert.equal(protocol.decode(protocol.byId.get(9103).rsp, packets[map].payload).cmd, 2)
        assert(mode > map)
        assert.equal(infos(packets, dead).length, 1)
        assert.equal(infos(packets, dead)[0].hp, 0)
        assert(infos(packets, dead)[0].index > mode)
        assert.equal(infos(packets, live).length, 1)
        assert.equal(infos(packets, live)[0].alive_state, 0)
        assert.equal(infos(packets, live)[0].final_blow_guid, '0')
        assert.equal(infos(packets, unrelated).length, 0)
        assert.equal(f.state().combat.entities[unrelated], undefined)
        assert.equal(f.state().combat.enemyActivations[dead].generation, generation)
        const combat = structuredClone(f.state().combat)
        const retry = f.call('WorldMapTakeElevator', { obj_id: elevator.row.id, floor: 1 })
        assert(!retry.some((packet) => [9103, 10009].includes(packet.id)))
        assert.deepEqual(f.state().combat, combat)
        f.game.tick(f.session.id, f.session)
        const before = f.database(),
            pending = f.store.pending.get(f.session.id)
        const idle = f.game.tick(f.session.id, f.session)
        assert(!idle.some((packet) => [9103, 10009].includes(packet.id)))
        assert.deepEqual(f.database(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
    } finally {
        f.store.close()
    }
})

test('actual EnterWorldMap uses central snapshots once without repeating the worldSync fallback', () => {
    const f = fixture('combat-central-worldsync')
    try {
        const dead = f.seed(971005),
            live = f.seed(971006)
        f.hit(dead, -enemyDefinition(tables, f.state(), dead).max_hp)
        const packets = f.call('EnterWorldMap', { map_id: elevator.map }),
            map = packets.findIndex((packet) => packet.id === 9103),
            mode = packets.findIndex((packet) => packet.id === 11055)
        assert(map >= 0 && mode > map)
        assert.equal(packets.filter((packet) => packet.id === 11055).length, 1)
        assert.equal(infos(packets, live).length, 1)
        assert.equal(infos(packets, live)[0].alive_state, 0)
        assert.equal(infos(packets, dead).length, 1)
        assert.equal(infos(packets, dead)[0].hp, 0)
        assert(infos(packets, dead)[0].index > mode && infos(packets, live)[0].index > mode)
    } finally {
        f.store.close()
    }
})

test('actual material marker interaction publishes each newly admitted actor once after its dynamic47', () => {
    const f = fixture('combat-central-material')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 60
            state.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '500'
        })
        const material = tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
        f.call('MultiCampaignCreate', { dungeon_id: material.dungeonId, scene_type: 12 })
        f.call('MultiCampaignPlayerLoadFinish')
        const run = f.state().entrust.run,
            marker = getEntrustCatalog(tables).stages(run.entrust_id, run.kind)[0].row
        const packets = f.call('WorldObjInteract', {
                objs: [{ obj: { obj_id: marker.id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
            }),
            map = packets.findIndex(
                (packet) =>
                    packet.id === 9103 && protocol.decode(protocol.byId.get(9103).rsp, packet.payload).cmd === 47,
            ),
            actors = f
                .state()
                .entrust.run.scene_objects.filter((row) => row.active && row.expand_data?.battle_group)
                .flatMap((row) => row.expand_data.battle_group.monsters)
        assert(map >= 0 && actors.length)
        for (const actor of actors) {
            const alive = infos(packets, actor.uid).filter((row) => row.hp > 0 && row.alive_state === 0)
            assert.equal(
                alive.length,
                1,
                'central publishing and Entrust control publication must not repeat an admitted actor',
            )
            assert(alive[0].index > map)
            assert.equal(alive[0].reason, 1)
            assert.equal(alive[0].sp, 0)
            assert.equal(alive[0].final_blow_guid, '0')
        }
    } finally {
        f.store.close()
    }
})

test('real9138 fresh initialization retains accepted partial damage and nonzero SP instead of restoring table maxima', () => {
    const f = fixture('combat-central-partial-vitals')
    try {
        const id = f.seed(971040),
            max = enemyDefinition(tables, f.state(), id).max_hp
        assert(max > 17)
        f.hit(id, -17)
        f.edit((state) => {
            state.combat.entities[id].sp = 37
        })
        const packets = f.call('WorldMapTakeElevator', { obj_id: elevator.row.id, floor: 1 }),
            rows = infos(packets, id)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].hp, max - 17)
        assert.equal(rows[0].sp, 37)
        assert.equal(rows[0].final_blow_guid, '0')
        assert.equal(f.state().combat.entities[id].hp, max - 17)
        assert.equal(f.state().combat.entities[id].sp, 37)
    } finally {
        f.store.close()
    }
})

test('unmarked standalone abyss projection keeps current partial HP, nonzero SP and producer reason', () => {
    const f = abyssFixture('combat-standalone-vitals')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const run = f.state().abyssRun,
            enemy = Object.values(f.state().combat.entities).find((row) => run.wave_objects.includes(row.object_id))
        f.time.now++
        f.call('BattleInfoReduce', {
            base_time: String(f.time.now * 1000),
            uint64_dic: [run.heroes[0].guid, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -17 } }],
        })
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.entities[enemy.uuid].sp = 41
        })
        const packets = []
        f.store.transact(f.session.id, 0, (state) => {
            syncAbyssBattleScene({
                state,
                tables: f.tables,
                now: f.time.now,
                push: (name, value) => packets.push({ name, value }),
            })
        })
        const row = packets
            .filter((packet) => packet.name === 'CSProtoObjBattleInfoSync')
            .flatMap((packet) => packet.value.infos)
            .find((info) => info.uuid === enemy.uuid)
        assert(row, 'a producer with no stream/central marker keeps its original packet')
        assert.equal(row.hp, enemy.hp - 17)
        assert.equal(row.sp, 41)
        assert.equal(row.reason, 1)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.hp - 17)
    } finally {
        f.store.close()
    }
})

test('stream-local initialization pairing keeps incompatible fields, ordinary repeats and a legal dead-to-new-alive event', () => {
    const f = fixture('combat-scoped-initialization')
    try {
        const id = f.seed(971050),
            state = f.state(),
            packets = [],
            key = {},
            encode = (name, value) => {
                const entry = protocol.byName.get(name)
                packets.push({ id: entry.id, payload: protocol.encode(entry.rsp, value) })
            },
            push = Object.assign(encode, { combatSnapshotStream: key }),
            c = { state, tables, now: f.now(), push, pushBefore: push, combatSnapshotStream: key },
            hp = enemyDefinition(tables, state, id).max_hp,
            producer = { uuid: id, hp, sp: 0, alive_state: 0, reason: 1 }
        publishCombatSceneSnapshot(c, [producer], () => publishCombatEnemyActivations(c))
        assert.equal(infos(packets, id).length, 1)
        assert.equal(infos(packets, id)[0].reason, 1)
        publishCombatSceneSnapshot(c, [producer], () => {})
        assert.equal(infos(packets, id).length, 2, 'ordinary repeat does not inherit a consumed fresh pairing')
        const activation = state.combat.enemyActivations[id]
        state.combat.enemyAlivePending[id] = { generation: activation.generation, pack_id: activation.packIds[0] }
        publishCombatEnemyActivations(c)
        publishCombatSceneSnapshot(c, [{ ...producer, sp: 8 }], () => {})
        assert.equal(infos(packets, id).at(-1).sp, 8, 'different SP/reason is not suppressed')
        state.combat.enemyAlivePending[id] = { generation: activation.generation, pack_id: activation.packIds[0] }
        publishCombatEnemyActivations(c)
        const peerPackets = [],
            peerPush = Object.assign((name, value) => peerPackets.push({ name, value }), { combatSnapshotStream: {} })
        publishCombatSceneSnapshot({ ...c, push: peerPush }, [{ ...producer, reason: 0 }], () => {})
        assert.equal(peerPackets.length, 1, 'another output stream cannot borrow this stream initialization')
        push('CSProtoObjBattleInfoSync', { infos: [{ uuid: id, hp: 0, alive_state: 1, reason: 0 }] })
        activateCombatGroup(state, {
            root: id,
            scopeKey: activation.scopeKey + ':retry',
            packIds: activation.packIds,
            activatedAtMs: f.now() * 1000,
        })
        publishCombatSceneSnapshot(c, [{ ...producer, reason: 0 }], () => {})
        assert.equal(infos(packets, id).at(-2).hp, 0)
        assert.equal(
            infos(packets, id).at(-1).hp,
            hp,
            'a new activation after death is not merged into an old fresh snapshot',
        )
    } finally {
        f.store.close()
    }
})

test('actual9151 handler is isolated under a shallow deferred transaction when its alive encoding fails', () => {
    const f = fixture('combat-central-shallow-ready'),
        original = protocol.encode
    try {
        const live = f.seed(971010),
            before = structuredClone(f.state()),
            saved = f.database(),
            pending = f.store.pending.get(f.session.id),
            entry = protocol.byName.get('CSProtoMapLoadFinish'),
            handler = f.game.handlers.get(entry.id)
        const run = () =>
            f.store.transact(
                f.session.id,
                entry.id,
                (state) => {
                    const packets = [],
                        push = (name, data) => {
                            const type = protocol.byName.get(name)
                            packets.push({ id: type.id, payload: protocol.encode(type.rsp, data) })
                        }
                    handler({ state, now: f.now(), tables, push, pushBefore: push }, {})
                    return packets
                },
                { defer: true, fork: (base) => ({ ...base, world: { ...base.world } }) },
            )
        protocol.encode = function (name, data) {
            if (name.endsWith('SCObjBattleInfoSync')) throw Error('injected-9151-central-codec')
            return original.call(this, name, data)
        }
        assert.throws(run, /injected-9151-central-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.database(), saved)
        assert.equal(f.store.pending.get(f.session.id), pending)
        protocol.encode = original
        assert.equal(infos(run(), live).length, 1)
        assert.deepEqual(f.database(), saved, 'successful deferred publication still avoids a disk write')
        assert.equal(
            infos(run(), live).length,
            0,
            'a consumed alive event does not replay without a genuine new runtime',
        )
    } finally {
        protocol.encode = original
        f.store.close()
    }
})

test('actual catch retires a pending actor so a later real9138 object refresh cannot publish it alive', () => {
    const f = fixture('combat-central-capture')
    try {
        const captured = f.seed(971020, { capture: true }),
            live = f.seed(971021)
        let item
        f.edit((state) => {
            item = tables.get('common_item').find((row) => row.type === 410 && row.subId > 0).id
            state.player.sbag_infos.items.push({ guid: '9912345', itemid: item, itemtype: 3, itemnum: 1 })
        })
        f.call('GetCatchPetInfo', { tar_id: [captured], day_weather: 1, reason: 1, pet_len_id: 0 })
        const reserved = f.call('CatchPetCard', {
                item_id: item,
                is_create: true,
                client_param: '123456',
            }),
            cardType = protocol.byName.get('CSProtoCatchPetCard'),
            card = protocol.decode(cardType.rsp, reserved.find((packet) => packet.id === cardType.id).payload)
        f.call('CatchPet', { tar_id: captured, item_id: item, catch_key: card.catch_key, day_weather: 1 })
        assert(f.state().petCaptureResults[captured])
        const packets = f.call('WorldMapTakeElevator', { obj_id: elevator.row.id, floor: 1 })
        assert(packets.some((packet) => packet.id === 9103))
        assert.equal(infos(packets, captured).length, 0)
        assert.equal(infos(packets, live).length, 1)
        assert.equal(f.state().combat.entities[captured].captured, true)
    } finally {
        f.store.close()
    }
})

test('actual SwitchPetAction peer broadcast leaves self scene cache and pending alive state untouched', () => {
    const f = fixture('combat-central-peer-action')
    try {
        f.seed(971030)
        let pet
        f.edit((s) => {
            pet = createPets(tables, s, 500001, 1)[0].guid
        })
        // Settle legitimate first-collection attributes and task observers
        // before measuring a presentation-only repeat broadcast.
        f.call('SwitchPetAction', { uuid: pet, type: 1 })
        const battleCache = () =>
            structuredClone(new Map([...f.session.syncCache].filter(([key]) => key.startsWith('battle.'))))
        const before = structuredClone(f.state().combat),
            cache = battleCache()
        const packets = f.call('SwitchPetAction', { uuid: pet, type: 2 })
        assert(packets.some((packet) => packet.audience))
        assert(!packets.some((packet) => [9103, 11055, 10009].includes(packet.id)))
        assert.deepEqual(f.state().combat.enemyAlivePending, before.enemyAlivePending)
        assert.deepEqual(battleCache(), cache)
    } finally {
        f.store.close()
    }
})

test('actual abyss retry clears old terminal presentation and scene-ready replay never kills the new same-pack actor', () => {
    const f = abyssFixture('combat-central-retry')
    try {
        f.call('AbyssChallenge', f.request())
        f.time.now++
        f.call('AbyssChallengeRealStart')
        const run = f.state().abyssRun,
            enemy = Object.values(f.state().combat.entities).find((row) => run.wave_objects.includes(row.object_id)),
            oldFrame = {
                base_time: String(f.time.now * 1000 + 500),
                uint64_dic: [run.heroes[0].guid, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            }
        f.call('BattleInfoReduce', oldFrame)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, 0)
        f.call('AbyssChallengeRetry')
        const packets = f.call('AbyssChallengeRealStart'),
            fresh = f.state().combat.entities[enemy.uuid]
        assert(fresh.hp > 0)
        assert.equal(fresh.pack_id, enemy.pack_id)
        const freshInfos = packets
            .filter((packet) => packet.id === 10009)
            .flatMap((packet) => f.p.decode(f.p.byId.get(10009).rsp, packet.payload).infos)
            .filter((row) => row.uuid === enemy.uuid)
        assert(freshInfos.some((row) => row.hp === fresh.hp && row.alive_state === 0 && row.final_blow_guid === '0'))
        assert(!freshInfos.some((row) => row.hp === 0 || row.alive_state === 1))
        f.call('BattleInfoReduce', oldFrame)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, fresh.hp)
        const ready = f
            .call('MapLoadFinish')
            .filter((packet) => packet.id === 10009)
            .flatMap((packet) => f.p.decode(f.p.byId.get(10009).rsp, packet.payload).infos)
        assert(!ready.some((row) => row.uuid === enemy.uuid && row.hp === 0))
        assert.equal(f.state().combat.entities[enemy.uuid].hp, fresh.hp)
    } finally {
        f.store.close()
    }
})

test('actual abyss timeout tick emits its own dynamic47 without reviving, killing or reallocating actors and then stays idle', () => {
    const f = abyssFixture('combat-central-tick')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        f.game.tick(f.session.id, f.session)
        const before = structuredClone(f.state().combat),
            run = f.state().abyssRun
        f.time.now = run.real_start_time + abyssBattlePlan(f.tables, run.dungeon_id).limit
        const packets = f.game.tick(f.session.id, f.session)
        assert(
            packets.some(
                (packet) => packet.id === 9103 && f.p.decode(f.p.byId.get(9103).rsp, packet.payload).cmd === 47,
            ),
        )
        assert.equal(f.state().abyssRun.phase, 'lost')
        assert(!packets.some((packet) => packet.id === 10009))
        assert.equal(f.state().combat.runtimeEpoch, before.runtimeEpoch)
        for (const [id, actor] of Object.entries(before.entities))
            assert.equal(f.state().combat.entities[id].hp, actor.hp)
        const saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        assert(!f.game.tick(f.session.id, f.session).some((packet) => [9103, 10009].includes(packet.id)))
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved,
        )
    } finally {
        f.store.close()
    }
})

// Transport boundary assertion, not an assertion of a current client sender:
// existing public peer handlers do not emit a peer9103 scene-entry packet.
test('peer-only9103 scene entries cannot invalidate the sender own sync-delta battle cache', () => {
    const entry = protocol.byName.get('CSProtoWorldMapSync')
    for (const meta of [{ recipient: 2 }, { audience: { kind: 'map', map: elevator.map, sender: 1 } }]) {
        const bucket = new Map([['existing-own-actor', '{"hp":7}']]),
            session = { id: 1, syncCache: new Map([['battle.infos', bucket]]) },
            packet = { id: entry.id, payload: protocol.encode(entry.rsp, { cmd: 49, map_id: elevator.map }), ...meta }
        const before = structuredClone(session.syncCache)
        assert.deepEqual(optimizeSyncPackets(protocol, session, [packet], 'peer-boundary'), [packet])
        assert.deepEqual(session.syncCache, before, 'a destination proxy change for a peer is not a local scene change')
        assert.equal(session.syncCache.get('battle.infos'), bucket, 'the original own-cache bucket is retained')
    }
})
