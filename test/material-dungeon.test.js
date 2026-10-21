import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialDungeonUnlocked } from '../src/material-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, r = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 45
        s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
    })
    const state = () => store.load(session.id).state
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: {
                            step: state().worldObjects[`${state().world.map_id}:${id}`]?.state_data?.step ?? 0,
                        },
                    },
                    interact_type: 2,
                },
            ],
        })
    const kill = (id, damage) => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((x) => x.object_id === id)
        return call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((x) => x.uuid)],
            battle_info: enemies.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: damage ?? -x.hp },
            })),
            base_time: '0',
        })
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state,
        interact,
        kill,
        tick: (n) => (now += n),
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}

test('material mappings cover all92 current configurations and preserve explicit errors for three missing wave indices', () => {
    const f = fixture('material-catalog'),
        c = getEntrustCatalog(f.tables),
        gaps = []
    try {
        for (const m of f.tables.get('dungeon_material')) {
            const x = c.get(m.id)
            assert.equal(x.material.id, m.id)
            assert.equal(x.city.type, 12)
            assert.equal(x.chest.worldFilter, '4|' + m.dungeonId)
            try {
                c.stages(m.id)
                c.victoryObjects(m.id)
                c.chest(m.id)
            } catch (e) {
                assert.equal(e.code, ErrorCode.GameConfig)
                gaps.push(m.id)
            }
        }
        assert.deepEqual(gaps, [30604, 30803, 30804])
        const boss = c.stages(20701)
        assert.equal(boss[0].row.id, 1500013)
        assert.equal(boss[0].index, 1)
    } finally {
        f.store.close()
    }
})

test('9510 scene12 follows real waves, synchronizes material stars, pays chest shares and starts a fresh replay', () => {
    const f = fixture('material-full-flow')
    try {
        const before = structuredClone(f.state().world)
        const entry = f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        assert.equal(f.state().world.map_id, 60000)
        assert.equal(f.state().entrust.run.kind, 'material')
        assert.equal(f.state().materialDungeonRecords?.[30101], undefined)
        assert(entry.some((p) => p.id === 9513))
        f.call('MultiCampaignPlayerLoadFinish')
        f.call('MultiCampaignPlayerLoaded')
        f.call('StartDungeonClientOk')
        f.call('MultiCampaignPlayerLoadingPageComplete')
        const stages = getEntrustCatalog(f.tables).stages(30101)
        f.interact(stages[0].row.id)
        const sqlChanges = () => f.store.db.prepare('SELECT total_changes() AS n').get().n
        const changesBeforeHit = sqlChanges()
        f.kill(stages[1].row.id, -1)
        assert.equal(sqlChanges(), changesBeforeHit, 'nonlethal battle reports stay in memory')
        assert.equal(f.state().materialDungeonRecords?.[30101], undefined)
        for (const stage of stages.filter((x) => x.type === 50)) {
            assert.equal(f.state().entrust.run.stage_index, stage.index)
            const actors = Object.values(f.state().combat.entities).filter((x) => x.object_id === stage.row.id)
            assert(actors.length)
            assert(actors.every((x) => x.level === 30 && x.hp > 0))
            f.kill(stage.row.id)
        }
        const run = f.state().entrust.run
        assert.equal(run.battle_complete, true)
        assert.equal(run.star_mask, 7)
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
        assert.equal(f.state().materialDungeonRecords[30101].material_star, 7)
        assert.equal(f.state().entrust.records[30101], undefined)
        f.store.flushPending()
        const persisted = JSON.parse(f.store.playerById.get(f.session.id).state)
        assert.equal(persisted.materialDungeonRecords[30101].success_count, 1)
        assert(materialDungeonUnlocked('13112#30101#1', f.state()))
        const login = f.reload()
        const e = f.protocol.byName.get('SCProtoDungeonMaterialInfoSync')
        assert.equal(
            f.protocol
                .decode(e.rsp, login.find((p) => p.id === 11600).payload)
                .infos.find((x) => x.material_id === 30101).material_star,
            7,
        )
        const stable = f.state().ornaments?.length ?? 0
        const chest = getEntrustCatalog(f.tables).chest(30101)
        const material = f.tables.find('dungeon_material', 30101),
            original = material.challengeReward
        // Corrupt an earned bonus to verify rollback after base-pool rolls.
        material.challengeReward = original
            .split('|')
            .map((id, i) => (i === 2 ? '4294967295' : id))
            .join('|')
        const beforeFailure = structuredClone(f.state())
        try {
            assert.throws(
                () => f.call('StaminaBoxGet', { box_id: chest.id, times: 2 }),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), beforeFailure)
        } finally {
            material.challengeReward = original
        }
        f.call('StaminaBoxGet', { box_id: chest.id, times: 2 })
        assert.equal(f.state().ornaments.length, stable + 4)
        assert.equal(f.state().player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val, '420')
        const after = structuredClone(f.state())
        f.call('StaminaBoxGet', { box_id: chest.id, times: 2 })
        assert.equal(f.state().ornaments.length, after.ornaments.length)
        assert.equal(f.state().player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val, '420')
        f.call('MultiCampaignQuit')
        assert.equal(f.state().world.map_id, before.map_id)
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        assert.equal(f.state().entrust.run.stage_index, 1)
        assert(!f.state().entrust.run.battle_complete)
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(stages[0].row.id)
        assert(
            Object.values(f.state().combat.entities)
                .filter((x) => x.object_id === stages[1].row.id)
                .every((x) => x.hp > 0),
        )
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
    } finally {
        f.store.close()
    }
})

test('the boss marker with capital AutoBattleIndex starts its configured enemy and keeps an aborted run unrecorded', () => {
    const f = fixture('material-boss-marker')
    try {
        const m = f.tables.find('dungeon_material', 20701)
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.lv = 99))
        f.call('MultiCampaignCreate', { dungeon_id: m.dungeonId, scene_type: 12 })
        const stages = getEntrustCatalog(f.tables).stages(m.id)
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(stages[0].row.id)
        assert.equal(f.state().entrust.run.stage_index, 2)
        assert(Object.values(f.state().combat.entities).some((x) => x.object_id === stages[1].row.id && x.hp > 0))
        f.call('MultiCampaignQuit')
        assert.equal(f.state().materialDungeonRecords?.[m.id], undefined)
    } finally {
        f.store.close()
    }
})

test('entry rejects locked and malformed configurations, foreign modes and active runs without changing the account', () => {
    const f = fixture('material-validation')
    try {
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.lv = 1))
        let before = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 }),
            (e) => e.code === ErrorCode.EntrustUnlock,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.lv = 99))
        before = structuredClone(f.state())
        for (const r of [
            { dungeon_id: 0xffffffff, scene_type: 12 },
            { dungeon_id: 31960, scene_type: 12, stage_id: 1 },
        ]) {
            assert.throws(() => f.call('MultiCampaignCreate', r))
            assert.deepEqual(f.state(), before)
        }
        const gap = f.tables.find('dungeon_material', 30604)
        f.store.transact(f.session.id, 0, (s) => {
            s.materialDungeonRecords = { 30603: { material_id: 30603, material_star: 0, success_count: 1 } }
        })
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignCreate', { dungeon_id: gap.dungeonId, scene_type: 12 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        before = structuredClone(f.state())
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        assert.deepEqual(f.state(), before)
        assert.equal(f.state().materialDungeonRecords?.[30101], undefined)
        assert.throws(() => f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 }))
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('the13112 first-clear sentinel accepts zero-star records but never treats a missing record as a clear', () => {
    const s = {
        player: { basic_info: { lv: 50 } },
        materialDungeonRecords: { 30101: { success_count: 1, material_star: 0 } },
    }
    assert(materialDungeonUnlocked('2004#15|13112#30101#1', s))
    assert(!materialDungeonUnlocked('13112#30102#1', s))
    assert(!materialDungeonUnlocked('13112#30101#2', s))
    s.materialDungeonRecords[30101].material_star = 5
    assert(materialDungeonUnlocked('13112#30101#2', s))
    assert(!materialDungeonUnlocked('13112#30101#3', s))
})
