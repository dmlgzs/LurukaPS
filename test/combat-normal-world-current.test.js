import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { completedEnemyGroup } from '../src/enemy-group-completion.js'
import { playerIsInBattle } from '../src/player-battle-state.js'
import { qualifyCurrentCombatWorld, currentFixedGroup } from './combat-normal-current-fixture.js'
import { createNormalStarterFixture } from './normal-starter-current-fixture.js'
import { TaskGraphs, asList } from '../src/tasks.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { combatEntityStates } from '../src/combat-enemy-lifecycle.js'

// Current EntityService10009 precedes10706; ACK does not release AOI waiters.
// Process entire scene streams: a return-map HP block may precede later11234.
class LifeConsumer {
    life = new Map()
    acks = new Map()
    ready = new Map()
    events = []
    map = null
    consume(f, packets) {
        for (const p of packets) {
            if (p.audience || (p.recipient !== undefined && p.recipient !== f.session.id)) continue
            const e = f.protocol.byId.get(p.id),
                v = e.rsp ? f.protocol.decode(e.rsp, p.payload) : {}
            if (p.id === 9103 && [49, 256].includes(v.cmd)) {
                this.life.clear()
                this.ready.clear()
                this.acks.clear()
                this.map = v.map_id
            }
            if (p.id === 11234) for (const r of v.objs) this.acks.set(r.guid, r.agent_uid)
            if (p.id === 10009)
                for (const r of v.infos) {
                    const old = this.life.get(r.uuid) ?? {}
                    this.life.set(r.uuid, { ...old, ...r })
                    if (Object.hasOwn(r, 'hp')) this.events.push({ type: 'life', ...r })
                }
            if (p.id === 11063 && [3, 4, 7].includes(v.obj?.obj_type)) {
                const data = v.obj.obj_data[0].cli_battle_data,
                    id = data.unit_id,
                    life = this.life.get(id)
                assert.equal(this.acks.get(id), v.agent_uid, 'real admission ACK precedes appear')
                assert(life && Object.hasOwn(life, 'hp'), 'no alive birth without a current-scene HP cache')
                assert.equal(data.fobj_base_data.hp, life.hp)
                this.ready.set(id, v.agent_uid)
                this.events.push({ type: 'appear', uuid: id, ...life })
            }
            if (p.id === 10706)
                for (const r of v.battle_info) {
                    const h = r.hurt_info
                    if (h && h.cur_hp === 0) {
                        const resolve = (id) => {
                            if (!v.uint64_dic.length) return id
                            const n = BigInt(id)
                            assert(n <= BigInt(v.uint64_dic.length))
                            return n === 0n ? '0' : v.uint64_dic[Number(n) - 1]
                        }
                        const life = this.life.get(resolve(h.tar_id))
                        assert(
                            life && life.hp === 0 && life.alive_state === 1,
                            'terminal life is cached before hurt/death callback',
                        )
                        assert.equal(life.final_blow_guid, resolve(h.from_id))
                    }
                }
            if (p.id === 11064) {
                for (const [id, agent] of this.ready) if (agent === v.agent_uid) this.ready.delete(id)
            }
        }
    }
}

function worldFixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let nowMs = 1800000000000,
        seq = 1,
        session = {},
        client = new LifeConsumer(),
        last = []
    const game = new Game(protocol, store, tables, {
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
        gmEnabled: true,
    })
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e, name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0) }
    }
    const dispatch = (r) => {
        last = game.dispatch(session, r)
        client.consume({ protocol, session }, last)
        return last
    }
    const call = (name, data) => dispatch(frame(name, data)),
        state = () => store.load(session.id).state,
        gm = (s) => call('GMCommand', { command: Buffer.from(s).toString('base64') })
    call('EnterGame', { open_id: name })
    assert.equal(state().starterProfile.mode, 'normal')
    assert.equal(state().pets.length, 0)
    // Qualified independent post-tutorial input, no HP/death/kill witnesses.
    store.transact(session.id, 0, (s) => qualifyCurrentCombatWorld(tables, s))
    call('EnterWorldMap', { map_id: 100, point_id: 10045 })
    call('MapLoadFinish')
    assert.equal(state().world.map_id, 100)
    gm('give 5 500001 1')
    const manager = state().player.group_mgrs.find((r) => r.type === 1),
        group = manager.groups.find((r) => r.id === manager.cur_group),
        hero = group.control,
        pet = state().pets.find((p) => p.config_id === 500001).guid
    call('WearPet', { hero_guid: hero, pet_guid: pet })
    assert.equal(state().player.heros_info.heros.find((h) => h.guid === hero).pet_id, pet)
    assert.equal(state().pets.find((p) => p.guid === pet).hero_id, hero)
    const fixed = currentFixedGroup(tables, state(), { minHp: 3, minSlots: 2 })
    const pos = fixed.row.position.split('|').map((n) => Math.round(Number(n) * 100))
    call('StateUpdate', {
        move_msg: { map_id: 100, move: [{ uuid: hero, info: { pos: { x: pos[0], y: pos[1], z: pos[2] }, angle: 0 } }] },
    })
    call('TryCreateWorldObj', { objs: fixed.ids })
    for (const id of fixed.ids) assert.equal(client.life.get(id)?.hp, enemyDefinition(tables, state(), id).max_hp)
    return {
        tables,
        protocol,
        store,
        call,
        frame,
        dispatch,
        state,
        hero,
        pet,
        fixed,
        hit: (source, target, delta) => {
            nowMs += 2
            const data = {
                base_time: String(nowMs),
                uint64_dic: [source, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
            }
            const packets = call('BattleInfoReduce', data)
            return { data, packets }
        },
        client: () => client,
        last: () => last,
        cold: () => {
            session = {}
            client = new LifeConsumer()
            call('EnterGame', { open_id: name })
            return client
        },
        close: () => store.close(),
    }
}

test('normal current world AOI hero/pet HP0 clears exactly the real full group; same-runtime rebuild/cold cache stay dead and real map return creates a fresh safe generation', () => {
    const f = worldFixture('combat-normal-world-aoi')
    try {
        const ids = f.fixed.ids
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: ids[0], target_obj_ids: [f.hero], player_obj_ids: [f.state().player.basic_info.id] },
        })
        f.call('PlayerHatredIncSync', {
            inc: true,
            info: { id: String(f.state().player.basic_info.id), target_obj_ids: ids },
        })
        assert(playerIsInBattle(f.state()))
        const max = enemyDefinition(f.tables, f.state(), ids[0]).max_hp
        f.hit(f.hero, ids[0], -1)
        assert.equal(f.state().combat.entities[ids[0]].hp, max - 1)
        f.call('TryDeleteWorldObj', { u64s: ids })
        f.call('TryCreateWorldObj', { objs: ids })
        assert.equal(f.client().life.get(ids[0]).hp, max - 1, 'AOI release/recreate is not a heal or new battle')
        let oldFrame
        for (const [index, id] of ids.entries()) {
            const source = index === ids.length - 1 ? f.pet : f.hero,
                hp = f.state().combat.entities[id]?.hp ?? enemyDefinition(f.tables, f.state(), id).max_hp
            const result = f.hit(source, id, -hp)
            oldFrame = result.data
            assert.equal(f.state().combat.entities[id].hp, 0)
            assert.equal(f.state().combat.entities[id].alive_state, 1)
            assert.equal(f.state().combat.entities[id].final_blow_guid, source)
            assert.equal(!!completedEnemyGroup(f.tables, f.state(), id), index === ids.length - 1)
            const lifeAt = result.packets.findIndex((p) => p.id === 10009),
                hurtAt = result.packets.findIndex((p) => p.id === 10706)
            assert(lifeAt >= 0 && lifeAt < hurtAt)
        }
        assert(!playerIsInBattle(f.state()))
        assert.deepEqual(f.state().combat.hatred, { objects: {}, players: {} })
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: ids[0], target_obj_ids: [f.hero], player_obj_ids: [f.state().player.basic_info.id] },
        })
        assert(!playerIsInBattle(f.state()), 'late hatred cannot reopen a terminal group')
        const epoch = f.state().combat.runtimeEpoch,
            pets = f.state().pets.map((p) => [p.guid, p.config_id, p.lv])
        f.call('MapLoadFinish')
        assert(ids.every((id) => f.client().life.get(id)?.hp === 0))
        f.cold()
        assert.equal(f.state().world.map_id, 100)
        assert(
            ids.every((id) => combatEntityStates(f.state().combat)[id]?.hp === 0),
            'relogin must preserve the authoritative current-wave terminal state',
        )
        // Current SceneService reports9151 after the cold scene loads. Its
        // actual handler publishes terminal state before new AOI admissions.
        f.call('MapLoadFinish')
        assert(
            ids.every((id) => f.client().life.get(id)?.hp === 0),
            'fresh Native cache must receive terminal life without an old local cache',
        )
        assert.deepEqual(
            f.state().pets.map((p) => [p.guid, p.config_id, p.lv]),
            pets,
        )
        f.call('TryCreateWorldObj', { objs: ids })
        assert(ids.every((id) => f.client().life.get(id)?.hp === 0))
        f.call('EnterHome', { creator_id: f.state().player.basic_info.id })
        f.call('WorldQuitHome')
        assert.equal(f.state().world.map_id, 100)
        f.call('TryCreateWorldObj', { objs: ids })
        assert(f.state().combat.runtimeEpoch > epoch)
        for (const id of ids) {
            assert.equal(f.client().life.get(id)?.hp, enemyDefinition(f.tables, f.state(), id).max_hp)
            assert.equal(f.client().life.get(id).alive_state, 0)
            assert.equal(f.client().life.get(id).final_blow_guid, '0')
        }
        f.call('BattleInfoReduce', oldFrame)
        const target = oldFrame.uint64_dic[1]
        assert.equal(
            f.state().combat.entities[target]?.hp ?? enemyDefinition(f.tables, f.state(), target).max_hp,
            enemyDefinition(f.tables, f.state(), target).max_hp,
            'old accepted frame cannot kill fresh same-UID/same-pack actor',
        )
        f.hit(f.pet, target, -enemyDefinition(f.tables, f.state(), target).max_hp)
        assert.equal(f.state().combat.entities[target].hp, 0)
    } finally {
        f.close()
    }
})

test('genuine normal106001 first-wave current Trial1 reports kill actual admitted wolves before ordinary task completion callbacks', () => {
    const f = createNormalStarterFixture('combat-first-wave-current', { starterProfile: 'normal' })
    try {
        f.login()
        assert.equal(f.state().world.map_id, 102)
        assert(
            f
                .state()
                .tasks.find((r) => r.task_id === 106001)
                ?.nodes.some((r) => r.node_id === 5),
        )
        f.call('EnterWorldMap', { map_id: 102 })
        f.call('MapLoadFinish')
        f.call('TrialGroupChange', { open: true, trial_id: 1 })
        const attacker = f.currentGroup().control
        assert.equal(BigInt(attacker) >> 56n, 5n)
        const q = { task_id: 106001, node_id: 5 }
        f.call('MultiTaskClientBefore', { task_params: [q] })
        const graph = new TaskGraphs(f.tables).get(106001),
            condition = asList(graph.nodes.get(5).__type_TaskConditionNodeData.conditionList)[0],
            data = condition.__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData,
            overrides = asList(data.enemiesDatas),
            ids = overrides.flatMap((row) =>
                taskEnemyPacks(f.tables, row).map((_, slot) =>
                    ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(row.createNpcId)).toString(),
                ),
            )
        const client = new LifeConsumer(),
            scope = { protocol: f.protocol, session: f.session() }
        client.consume(scope, f.call('TryCreateWorldObj', { objs: ids }))
        assert.equal(client.ready.size, ids.length)
        assert.throws(() => f.call('MultiTaskClientCondAfter', { task_params: [{ ...q, indexes: [0] }] }))
        for (const id of ids) {
            const before = f.state().combat.entities[id]?.hp ?? enemyDefinition(f.tables, f.state(), id).max_hp
            f.advanceMs(2)
            const hit = (delta) =>
                f.call('BattleInfoReduce', {
                    base_time: String(f.nowMs()),
                    uint64_dic: [attacker, id],
                    battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
                })
            client.consume(scope, hit(-1))
            assert.equal(f.state().combat.entities[id].hp, before - 1)
            f.advanceMs(2)
            client.consume(scope, hit(-(before - 1)))
            assert.equal(f.state().combat.entities[id].hp, 0)
            assert.equal(f.state().combat.entities[id].alive_state, 1)
        }
        for (const row of overrides)
            assert(
                completedEnemyGroup(
                    f.tables,
                    f.state(),
                    ids.find((id) => Number(BigInt(id) & 0xffffffffn) === row.createNpcId),
                ),
            )
        f.call('MultiTaskClientCondAfter', { task_params: [{ ...q, indexes: [0] }] })
        f.call('MultiTaskClientAfter', { task_params: [q] })
        assert(
            f
                .state()
                .tasks.find((r) => r.task_id === 106001)
                ?.finish_nodes.includes(5),
        )
    } finally {
        f.close()
    }
})
