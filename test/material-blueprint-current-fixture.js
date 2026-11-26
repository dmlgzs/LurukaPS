// Shared current-material Game fixture; account persistence is in memory.
// Historical prerequisite qualifications are explicit below, separate from target victories.
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialDungeonUnlocked } from '../src/material-dungeons.js'
import { restoreMissingStamina } from '../src/currency.js'

export function materialServerFixture(name, { previousClears = [], tables: suppliedTables } = {}) {
    const config = configuration(),
        tables = suppliedTables ?? new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        graphs = new TaskGraphs(tables),
        trace = []
    let nowMs = 1800000000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
    })
    // Historical prerequisite clears are explicit fixture qualifications only.
    // The material under test is never seeded as cleared or claimed.
    const qualify = (s) => {
        const graph = graphs.get(106015),
            npc = tables.find('worldmap_100', 400085),
            position = npc.position.split('|').map(Number)
        s.player.basic_info.lv = 80
        restoreMissingStamina(tables, s)
        s.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '10000'
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10001)))
        s.world.pos = {
            x: Math.round(position[0] * 100),
            y: Math.round(position[1] * 100),
            z: Math.round(position[2] * 100),
        }
        s.taskEpochs ??= {}
        s.taskEpochs[106015] = 1
        s.tasks = [
            {
                task_id: 106015,
                nodes: [makeNode(graph, 24, s)],
                finish_nodes: [22],
                reward_nodes: [],
                client_trace: true,
                start_time: Math.floor(nowMs / 1000),
            },
        ]
        s.taskRecords = (s.taskRecords ?? []).filter((row) => row.task_id !== 106015)
        const prior = new Set()
        const visit = (taskId) => {
            const row = tables.find('task', taskId)
            assert(row, 'current historical prerequisite row')
            for (const token of String(row.unlockcondition ?? '').split('|')) {
                const [kind, target] = token.split('#').map(Number)
                if (kind === 2007 && !prior.has(target)) {
                    prior.add(target)
                    visit(target)
                }
            }
        }
        visit(106015)
        assert(!prior.has(106015))
        for (const task_id of prior)
            if (!s.taskRecords.some((row) => row.task_id === task_id))
                s.taskRecords.push({ task_id, count: 1, time: 1790000000 })
        s.materialDungeonRecords = Object.fromEntries(
            previousClears.map((material_id) => {
                const row = tables.find('dungeon_material', material_id)
                assert(row)
                return [
                    material_id,
                    {
                        material_id,
                        material_star: 7,
                        difficulty_id: row.diff,
                        success_time: '1790000000',
                        success_count: 1,
                    },
                ]
            }),
        )
        return s
    }
    const state = () => store.load(session.id).state
    const call = (name, request = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        assert(row, 'current protocol alias ' + name)
        const payload = row.req ? protocol.encode(row.req, request) : Buffer.alloc(0)
        try {
            const packets = game.dispatch(session, { id: row.id, seq: seq++, payload })
            trace.push({ name, id: row.id, request, packets: packets.map((p) => p.id) })
            return packets
        } catch (e) {
            trace.push({ name, id: row.id, request, error: e.message, code: e.code })
            throw e
        }
    }
    const login = () => {
        session = {}
        const packets = call('EnterGame', { open_id: name, reconnect: true })
        if (state().entrust?.run)
            assert.equal(state().world.map_id, state().entrust.run.map_id, 'relogin retains the admitted material map')
        return packets
    }
    login()
    // Login may restore an unrelated guide scene. Establish this independent
    // qualified NPC-entry profile afterwards, exactly as the admission probe.
    store.transact(session.id, Math.floor(nowMs / 1000), qualify)
    call('TaskClientBefore', { task_id: 106015, node_id: 24 })
    call('ClientBehaviourRecord', { key: 1001, args: [400085, 106015, 24, 0, 1] })
    call('TaskClientCondAfter', { task_id: 106015, node_id: 24, indexes: [0] })
    call('TaskClientAfter', { task_id: 106015, node_id: 24 })
    assert(
        state()
            .tasks.find((task) => task.task_id === 106015)
            .finish_nodes.includes(24),
    )
    assert(!state().taskRecords.some((row) => row.task_id === 106015))
    const catalog = getEntrustCatalog(tables)
    const run = () => state().entrust?.run
    const begin = (id) => {
        const material = tables.find('dungeon_material', id)
        assert(materialDungeonUnlocked(material.unlock, state()), 'current admission gate')
        assert(!state().materialDungeonRecords[id], 'no result for material under test is inserted')
        const before = state(),
            packets = call('MultiCampaignCreate', { dungeon_id: material.dungeonId, scene_type: 12 })
        assert.equal(state().entrust.run.entrust_id, id)
        assert.equal(state().entrust.run.kind, 'material')
        assert.deepEqual(state().materialDungeonRecords, before.materialDungeonRecords)
        call('MultiCampaignPlayerLoadFinish')
        return packets
    }
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: {
                            step: state().worldObjects?.[`${state().world.map_id}:${id}`]?.state_data?.step ?? 0,
                        },
                    },
                    interact_type: 2,
                },
            ],
        })
    const living = (objectId) =>
        Object.values(state().combat?.entities ?? {}).filter((enemy) => enemy.object_id === objectId && enemy.hp > 0)
    const hurt = (objectId, { partial = false } = {}) => {
        assert.equal(state().world.map_id, run().map_id, 'material damage cannot use an enemy UUID from a departed map')
        const s = state(),
            enemies = living(objectId),
            hero = s.player.heros_info.heros.find((h) => h.type === 1 && !h.trail)
        assert(hero)
        assert(enemies.length > 0, 'configured active stage has real living enemies')
        const expected = new Map(enemies.map((e) => [e.uuid, partial ? e.hp - 1 : 0]))
        assert(enemies.every((e) => e.hp > 1 || !partial))
        nowMs += 2
        const packets = call('BattleInfoReduce', {
            base_time: String(nowMs),
            uint64_dic: [hero.guid, ...enemies.map((e) => e.uuid)],
            battle_info: enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: partial ? -1 : -e.hp },
            })),
        })
        for (const [uuid, hp] of expected)
            assert.equal(state().combat.entities[uuid].hp, hp, 'actual accepted damage changes HP')
        return packets
    }
    const advance = () => {
        const r = run(),
            stage = catalog.stages(r.entrust_id, 'material').find((s) => s.index === r.stage_index)
        assert(stage, 'stage from verified current graph contract')
        if (stage.type === 13) return interact(stage.row.id)
        assert.equal(stage.type, 50, 'only current marker or enemy execution is expected before clear')
        return hurt(stage.row.id)
    }
    const win = () => {
        for (let i = 0; i < 40 && !run().battle_complete; i++) advance()
        assert(run().battle_complete, 'actual battle must reach verified victory')
        return run()
    }
    const stamina = () => Number(state().player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val)
    const chest = () => catalog.chest(run().entrust_id, 'material')
    const reply = (name, packets) => {
        const e = protocol.byName.get('CSProto' + name)
        return protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
    }
    return {
        tables,
        protocol,
        store,
        game,
        trace,
        state,
        call,
        login,
        run,
        catalog,
        begin,
        interact,
        living,
        hurt,
        advance,
        win,
        stamina,
        chest,
        reply,
        close: () => store.close(),
    }
}
