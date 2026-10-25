import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { getEntrustCatalog, EntrustCatalog } from '../src/entrust.js'
import { materialBlueprintStages } from '../src/material-blueprint-stages.js'
import { ErrorCode } from '../src/error-codes.js'

const targets = [30604, 30803, 30804]
function withRows(tables, table, changed) {
    return {
        get: (name) => (name === table ? changed : tables.get(name)),
        find: (name, id) => (name === table ? changed.find((r) => r.id === Number(id)) : tables.find(name, id)),
    }
}
test('compiled tag path resolves all92 routes, preserves indexed89 and follows tag order rather than object IDs', () => {
    const f = achievementFixture('material-blueprint-schema')
    try {
        const c = getEntrustCatalog(f.tables)
        for (const material of f.tables.get('dungeon_material')) {
            const route = c.get(material.id, 'material'),
                stages = c.stages(material.id, 'material')
            assert.equal(stages[0].type, 13)
            assert.equal(stages.at(-1).type, 30)
            assert.equal(c.victoryObjects(material.id, 'material').length, stages.length - 2)
            if (!targets.includes(material.id))
                assert.equal(materialBlueprintStages(f.tables, route.scene, material, stages), stages)
            else
                assert.deepEqual(
                    stages.map((r) => [r.index, r.type, r.row.commonTag]),
                    [
                        [1, 13, '1'],
                        [2, 50, '2'],
                        [3, 50, '3'],
                        [4, 30, '0'],
                    ],
                )
        }
        const map = f.tables
            .get('worldmap_60064')
            .map((r) => (r.id === 5 ? { ...r, commonTag: '3' } : r.id === 6 ? { ...r, commonTag: '2' } : r))
        const reversed = new EntrustCatalog(withRows(f.tables, 'worldmap_60064', map)).stages(30604, 'material')
        assert.deepEqual(
            reversed.map((r) => r.row.id),
            [3, 6, 5, 4],
        )
    } finally {
        f.store.close()
    }
})
test('missing waits never grant empty victory; extra same-tag objects, conflicting anchors and unknown topology close', () => {
    const f = achievementFixture('material-blueprint-closed')
    try {
        const raw = f.tables.get('worldmap_60064')
        for (const map of [
            raw.map((r) => (r.id === 5 ? { ...r, commonTag: '' } : r)),
            raw.map((r) => (r.id === 5 ? { ...r, expandParams: r.expandParams + '|autoBattleIndex#9' } : r)),
            [...raw, { ...raw.find((r) => r.id === 1800000), id: 100000, commonTag: '2' }],
        ])
            assert.throws(
                () => new EntrustCatalog(withRows(f.tables, 'worldmap_60064', map)).stages(30604, 'material'),
                (e) => [ErrorCode.GameConfig, ErrorCode.FunctionClosed].includes(e.code),
            )
        for (const patch of [
            { blueprintId: 0 },
            { intParam: 'enemyTag2#4' },
            { stringParam: 'enemyTag2#4' },
            { boolParam: 'isBossOnly#1' },
        ]) {
            const scenes = f.tables.get('dungeon_scene').map((r) => (r.id === 60064 ? { ...r, ...patch } : r))
            assert.throws(
                () => new EntrustCatalog(withRows(f.tables, 'dungeon_scene', scenes)).stages(30604, 'material'),
                (e) => e.code === ErrorCode.FunctionClosed,
            )
        }
        const definitions = f.tables
            .get('world_blueprint')
            .map((r) => (r.id === 300351 ? { ...r, intParam: 'enemyTag2#4' } : r))
        assert.throws(
            () => new EntrustCatalog(withRows(f.tables, 'world_blueprint', definitions)).stages(30604, 'material'),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
    } finally {
        f.store.close()
    }
})
test('three real material entries advance their configured groups, clear once, preserve rollback and pay their actual chest', () => {
    const f = achievementFixture('material-blueprint-actual')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 80
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '10000'
            // Earlier difficulties are prerequisite-only records, not these
            // three targets or claimed source events.
            s.materialDungeonRecords ??= {}
            function unlock(id) {
                const row = f.tables.find('dungeon_material', id)
                for (const token of String(row.unlock || '')
                    .split('|')
                    .filter(Boolean)) {
                    const [kind, prior] = token.split('#').map(Number)
                    if (kind === 2004) continue
                    assert.equal(kind, 13112)
                    if (targets.includes(prior)) continue
                    unlock(prior)
                    const old = f.tables.find('dungeon_material', prior)
                    s.materialDungeonRecords[prior] = {
                        material_id: prior,
                        difficulty_id: old.diff,
                        success_count: 1,
                        success_time: '1799999900',
                        material_star: 7,
                    }
                }
            }
            for (const id of targets) unlock(id)
        })
        const c = getEntrustCatalog(f.tables)
        const hit = (object) => {
            const s = f.state(),
                enemies = Object.values(s.combat.entities).filter((e) => e.object_id === object && e.hp > 0)
            assert(enemies.length)
            return f.call('BattleInfoReduce', {
                uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
                battle_info: enemies.map((e, i) => ({
                    hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
                })),
                base_time: '0',
            })
        }
        for (const id of targets) {
            f.call('MultiCampaignCreate', {
                dungeon_id: f.tables.find('dungeon_material', id).dungeonId,
                scene_type: 12,
            })
            f.call('MultiCampaignPlayerLoadFinish')
            const phases = c.stages(id, 'material'),
                map = f.state().world.map_id,
                marker = phases[0].row.id
            f.call('WorldObjInteract', {
                objs: [
                    {
                        obj: {
                            obj_id: marker,
                            complete: true,
                            state_data: { step: f.state().worldObjects[`${map}:${marker}`]?.state_data?.step ?? 0 },
                        },
                        interact_type: 2,
                    },
                ],
            })
            const [first, last] = phases.filter((p) => p.type === 50)
            assert.equal(f.state().worldObjects[`${map}:${first.row.id}`].active, true)
            assert.equal(f.state().worldObjects[`${map}:${last.row.id}`].active, false)
            if (id === 30604) {
                const before = structuredClone(f.state()),
                    packet = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'CSProtoWorldMapSync') throw Error('material-blueprint-codec')
                    return packet.call(this, name, ...args)
                }
                try {
                    assert.throws(() => hit(first.row.id), /material-blueprint-codec/)
                } finally {
                    f.game.packet = packet
                }
                assert.deepEqual(f.state(), before)
            }
            hit(first.row.id)
            assert.equal(f.state().materialDungeonRecords[id], undefined)
            assert.equal(f.state().worldObjects[`${map}:${last.row.id}`].active, true)
            hit(last.row.id)
            assert.equal(f.state().entrust.run.battle_complete, true)
            assert.equal(f.state().materialDungeonRecords[id].success_count, 1)
            const chest = c.chest(id, 'material')
            assert.equal(chest.worldmapid, phases.at(-1).row.id)
            const chestPackets = f.call('StaminaBoxGet', { box_id: chest.id, times: 1 })
            assert(chestPackets.some((p) => p.id === 9974))
            assert.equal(f.state().entrust.run.chest_claimed, true)
            f.call('EndDungeonScene')
            assert.equal(f.state().materialDungeonRecords[id].success_count, 1)
            f.call('MultiCampaignQuit')
        }
    } finally {
        f.store.close()
    }
})
test('a blueprint-derived wave resumes afterSQLite reopen without reviving the defeated group', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'material-blueprint-stage-'))
    const file = path.join(folder, 'state.sqlite')
    let f = achievementFixture('material-blueprint-resume', file)
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 80
            s.materialDungeonRecords = {
                30603: {
                    material_id: 30603,
                    difficulty_id: 4,
                    material_star: 7,
                    success_count: 1,
                    success_time: '1799999900',
                },
            }
        })
        const id = 30604,
            c = getEntrustCatalog(f.tables)
        f.call('MultiCampaignCreate', { dungeon_id: f.tables.find('dungeon_material', id).dungeonId, scene_type: 12 })
        f.call('MultiCampaignPlayerLoadFinish')
        const phases = c.stages(id, 'material'),
            map = f.state().world.map_id
        const marker = phases[0].row.id
        f.call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: marker,
                        complete: true,
                        state_data: { step: f.state().worldObjects[`${map}:${marker}`]?.state_data?.step ?? 0 },
                    },
                    interact_type: 2,
                },
            ],
        })
        function finish(object) {
            const state = f.state(),
                enemies = Object.values(state.combat.entities).filter((e) => e.object_id === object && e.hp > 0)
            assert(enemies.length)
            f.call('BattleInfoReduce', {
                uint64_dic: [state.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
                battle_info: enemies.map((e, i) => ({
                    hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
                })),
                base_time: '0',
            })
        }
        finish(phases[1].row.id)
        assert.equal(f.state().entrust.run.stage_index, phases[2].index)
        assert.equal(f.state().materialDungeonRecords[id], undefined)
        f.store.close()
        f = achievementFixture('material-blueprint-resume', file)
        assert.equal(f.state().entrust.run.stage_index, phases[2].index)
        assert.equal(f.state().worldObjects[`${map}:${phases[1].row.id}`].active, false)
        assert(
            Object.values(f.state().combat.entities)
                .filter((e) => e.object_id === phases[1].row.id)
                .every((e) => e.hp === 0),
        )
        assert.equal(f.state().worldObjects[`${map}:${phases[2].row.id}`].active, true)
        finish(phases[2].row.id)
        assert.equal(f.state().materialDungeonRecords[id].success_count, 1)
    } finally {
        f.store.close()
        fs.rmSync(file, { force: true })
        fs.rmdirSync(folder)
    }
})
