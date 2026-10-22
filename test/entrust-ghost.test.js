import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { EntrustCatalog, ensureEntrustSceneObjects } from '../src/entrust.js'

const cfg = configuration(),
    p = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)

for (const entrustId of [1, 6])
    test(`commission ${entrustId} wave snapshots retain deaths without advertising ghost slots`, () => {
        const store = new Store(':memory:'),
            game = new Game(p, store, tables, { clock: () => 1800000000 }),
            session = {}
        let seq = 1
        const call = (name, r = {}) => {
            const entry = p.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, r) })
        }
        const objects = (packets) =>
            packets
                .filter((x) => x.id === p.byName.get('CSProtoWorldMapSync').id)
                .flatMap((x) => p.decode('WorldMapNotify', x.payload).map_info?.objs ?? [])
        const check = (rows, state) => {
            const groups = rows.filter((x) => x.expand_data?.battle_group)
            assert.ok(groups.length)
            for (const row of groups) {
                const group = row.expand_data.battle_group
                assert.equal(row.time, state.entrust.run.start_time)
                assert.equal(row.next_time, 0)
                // Mirrors ParseObjectData's inactive refresh-queue predicate.
                assert.equal(!row.active && row.next_time + 10 > row.time, false)
                assert.deepEqual(
                    group.world_indexes,
                    group.monsters.flatMap((monster, index) => {
                        const entity = state.combat.entities[monster.uid]
                        return entity.hp > 0 && entity.alive_state !== 1 && !entity.captured ? [index] : []
                    }),
                )
            }
        }
        try {
            call('EnterGame', { open_id: `ghost-entrust-${entrustId}` })
            store.transact(session.id, 0, (state) => {
                state.world.map_id = 100
                state.player.basic_info.lv = Math.max(...tables.get('player_level').map((row) => row.id))
                state.taskRecords = tables
                    .get('task')
                    .filter((row) => row.type === 1)
                    .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
                ;(state.entrust ??= {}).records = Object.fromEntries(
                    tables.get('dungeon_entrust').map((row) => [row.id, { entrust_id: row.id, entrust_star: 3 }]),
                )
            })
            const entry = call('EnterEntrust', { entrust_id: entrustId })
            let state = store.load(session.id).state
            check(objects(entry), state)
            const stages = new EntrustCatalog(tables).stages(entrustId)
            const marker = stages[0].row.id
            const started = call('WorldObjInteract', {
                objs: [{ obj: { obj_id: marker, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
            })
            state = store.load(session.id).state
            check(objects(started), state)
            const kill = (enemies) =>
                call('BattleInfoReduce', {
                    uint64_dic: [state.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
                    battle_info: enemies.map((e, index) => ({
                        hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: -e.hp },
                    })),
                    base_time: '0',
                })
            for (const stage of stages.filter((x) => x.type === 50)) {
                state = store.load(session.id).state
                const enemies = Object.values(state.combat.entities).filter((e) => e.object_id === stage.row.id)
                assert.ok(enemies.every((e) => e.hp > 0))
                const first = enemies[0]
                kill([first])
                state = store.load(session.id).state
                if (enemies.length > 1) {
                    assert.equal(state.entrust.run.stage_index, stage.index)
                    // A later world refresh during the wave must also exclude the
                    // single dead slot, without renumbering the living slots.
                    assert.equal(ensureEntrustSceneObjects(tables, state, 1800000000), true)
                    check(state.entrust.run.scene_objects, state)
                }
                const cleared = enemies.length > 1 ? kill(enemies.slice(1)) : []
                state = store.load(session.id).state
                if (cleared.length) check(objects(cleared), state)
                const dead = state.worldObjects[`${state.world.map_id}:${stage.row.id}`].expand_data.battle_group
                assert.ok(dead.monsters.every((e) => e.hp === 0))
                assert.equal(dead.monsters.length, enemies.length)
                assert.deepEqual(dead.world_indexes, [])
            }
            state = store.load(session.id).state
            assert.equal(state.entrust.run.battle_complete, true)
            // Repair old snapshots in place, retaining clear/chest/HP receipts.
            const run = structuredClone(state.entrust.run)
            for (const row of state.entrust.run.scene_objects.filter((x) => x.expand_data?.battle_group)) {
                const record = state.worldObjects[`${state.world.map_id}:${row.obj_id}`]
                delete record.time
                delete record.next_time
                record.expand_data.battle_group.world_indexes = record.expand_data.battle_group.monsters.map(
                    (_, i) => i,
                )
            }
            assert.equal(ensureEntrustSceneObjects(tables, state, 1800000000), true)
            check(state.entrust.run.scene_objects, state)
            for (const field of ['stage_index', 'battle_complete', 'star_mask', 'damage_total', 'chest_ready_time'])
                assert.equal(state.entrust.run[field], run[field])
            call('CampaignQuit')
            const reentry = call('EnterEntrust', { entrust_id: entrustId })
            state = store.load(session.id).state
            assert.ok(Object.values(state.combat.entities).every((e) => e.hp > 0))
            assert.equal(state.entrust.run.stage_index, stages[0].index)
            check(objects(reentry), state)
        } finally {
            store.close()
        }
    })
