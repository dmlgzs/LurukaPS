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

function finishMaterial(f) {
    f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
    f.call('MultiCampaignPlayerLoadFinish')
    const catalog = getEntrustCatalog(f.tables),
        stages = catalog.stages(30101)
    f.interact(stages[0].row.id)
    f.tick(3)
    for (const stage of stages.filter((row) => row.type === 50)) f.kill(stage.row.id)
    assert.equal(f.state().entrust.run.battle_complete, true)
    return { stages, chest: catalog.chest(30101) }
}

test('11850 after a paid material clear rebuilds the marker and live waves without paying or awarding again', () => {
    const f = fixture('material-restart-paid')
    try {
        const origin = structuredClone(f.state().world)
        const { stages, chest } = finishMaterial(f)
        f.call('StaminaBoxGet', { box_id: chest.id, times: 1 })
        const saved = f.state(),
            old = saved.entrust.run
        f.tick(10)
        const packets = f.call('MultiCampaignRestart'),
            next = f.state()
        assert(packets.some((packet) => packet.id === 11850))
        const sync = f.protocol.byName.get('CSProtoWorldMapSync')
        assert(
            packets
                .filter((packet) => packet.id === sync.id)
                .some((packet) => f.protocol.decode(sync.rsp, packet.payload).cmd === 49),
        )
        assert.equal(next.entrust.run.instance_id, old.instance_id + 1)
        assert.equal(next.entrust.run.restart_of, old.instance_id)
        assert.equal(next.entrust.run.stage_index, 1)
        assert.equal(next.entrust.run.status, 2)
        assert.equal(next.entrust.run.star, 0)
        assert.equal(next.entrust.run.damage_total, '0')
        assert.equal(next.entrust.run.battle_complete, undefined)
        assert.equal(next.entrust.run.battle_start_time, undefined)
        assert.equal(next.entrust.run.chest_claimed, undefined)
        assert.deepEqual(next.entrust.run.return_world, old.return_world)
        assert.deepEqual(next.materialDungeonRecords, saved.materialDungeonRecords)
        assert.deepEqual(next.player.sbag_infos, saved.player.sbag_infos)
        assert.deepEqual(next.ornaments, saved.ornaments)
        assert.equal(next.player.basic_info.gold, saved.player.basic_info.gold)
        assert.equal(
            next.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val,
            saved.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val,
        )
        const duplicate = f.call('MultiCampaignRestart')
        assert.equal(f.state().entrust.run.instance_id, next.entrust.run.instance_id)
        assert(!duplicate.some((packet) => packet.id === sync.id))
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(stages[0].row.id)
        const enemies = Object.values(f.state().combat.entities).filter((enemy) => enemy.object_id === stages[1].row.id)
        assert(enemies.length > 0)
        assert(enemies.every((enemy) => enemy.hp === enemy.max_hp && enemy.hp > 0))
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
        f.call('MultiCampaignQuit')
        assert.equal(f.state().world.map_id, origin.map_id)
        assert.deepEqual(f.state().world.pos, origin.pos)
    } finally {
        f.store.close()
    }
})

test('11850 can abandon an unclaimed box, while a late scene-codec failure preserves the old complete run', () => {
    const f = fixture('material-restart-unclaimed')
    try {
        const { chest } = finishMaterial(f)
        const saved = structuredClone(f.state()),
            packet = f.game.packet
        try {
            f.game.packet = function (name, ...args) {
                if (name === 'CSProtoWorldMapSync') throw Error('injected restart scene codec')
                return packet.call(this, name, ...args)
            }
            assert.throws(() => f.call('MultiCampaignRestart'), /injected restart scene codec/)
            assert.deepEqual(f.state(), saved)
        } finally {
            f.game.packet = packet
        }
        f.call('MultiCampaignRestart')
        const next = f.state()
        assert.equal(next.entrust.run.instance_id, saved.entrust.run.instance_id + 1)
        assert.equal(next.entrust.run.battle_complete, undefined)
        assert.deepEqual(next.player.sbag_infos, saved.player.sbag_infos)
        assert.deepEqual(next.player.attr_infos, saved.player.attr_infos)
        assert.deepEqual(next.materialDungeonRecords, saved.materialDungeonRecords)
        assert.throws(() => f.call('StaminaBoxGet', { box_id: chest.id, times: 1 }))
        assert.deepEqual(f.state(), next)
    } finally {
        f.store.close()
    }
})

test('11850 retries of the last allocatable instance remain idempotent after the identity counter is exhausted', () => {
    const f = fixture('material-restart-last-identity')
    try {
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        f.store.transact(f.session.id, 0, (s) => {
            s.entrust.nextInstanceId = Number.MAX_SAFE_INTEGER - 1
        })
        f.call('MultiCampaignRestart')
        assert.equal(f.state().entrust.run.instance_id, Number.MAX_SAFE_INTEGER - 1)
        assert.equal(f.state().entrust.nextInstanceId, Number.MAX_SAFE_INTEGER)
        const saved = structuredClone(f.state())
        const again = f.call('MultiCampaignRestart')
        assert(!again.some((packet) => packet.id === 9103))
        assert.deepEqual(f.state(), saved)
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(getEntrustCatalog(f.tables).stages(30101)[0].row.id)
        const active = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignRestart'),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), active)
    } finally {
        f.store.close()
    }
})

test('11850 rejects missing, wrong-map, corrupt and unconfigured dungeon contexts atomically with named errors', () => {
    const f = fixture('material-restart-invalid')
    try {
        let saved = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignRestart'),
            (error) => error.code === ErrorCode.NotInMultiCampaign,
        )
        assert.deepEqual(f.state(), saved)
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        const initial = structuredClone(f.state())
        for (const [mutate, code] of [
            [
                (s) => {
                    s.world.map_id = 101
                },
                ErrorCode.NotInDungeonMap,
            ],
            [
                (s) => {
                    s.entrust.run.dungeon_id = 1
                },
                ErrorCode.GameConfig,
            ],
            [
                (s) => {
                    s.entrust.nextInstanceId = Number.MAX_SAFE_INTEGER
                },
                ErrorCode.GameConfig,
            ],
            [
                (s) => {
                    s.entrust.run.status = 5
                },
                ErrorCode.DungeonNotIn,
            ],
        ]) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(initial))
                mutate(s)
            })
            saved = structuredClone(f.state())
            assert.throws(
                () => f.call('MultiCampaignRestart'),
                (error) => error.code === code,
            )
            assert.deepEqual(f.state(), saved)
        }
        f.store.transact(f.session.id, 0, (s) => Object.assign(s, structuredClone(initial)))
        const find = f.tables.find
        try {
            f.tables.find = function (name, id) {
                return name === 'dungeon_material' && id === 30101 ? undefined : find.call(this, name, id)
            }
            saved = structuredClone(f.state())
            assert.throws(
                () => f.call('MultiCampaignRestart'),
                (error) => error.code === ErrorCode.DungeonConfNotExist,
            )
            assert.deepEqual(f.state(), saved)
        } finally {
            f.tables.find = find
        }
    } finally {
        f.store.close()
    }
})

test('material mappings cover all92 current configurations including blueprint-derived missing wave indices', () => {
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
        assert.deepEqual(gaps, [])
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
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.player.basic_info.lv = Math.max(...f.tables.get('player_level').map((r) => r.id))),
        )
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
        const maxLevel = Math.max(...f.tables.get('player_level').map((row) => row.id))
        // A level absent from the actual table is corrupt state, not an
        // unrestricted high-level fixture. Keep production validation intact.
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.lv = maxLevel + 1))
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.player.basic_info.lv = Math.max(...f.tables.get('player_level').map((r) => r.id))),
        )
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
            s.materialDungeonRecords = {
                30603: {
                    material_id: 30603,
                    difficulty_id: f.tables.find('dungeon_material', 30603).diff,
                    material_star: 0,
                    success_count: 1,
                    success_time: '1799999900',
                },
            }
        })
        before = structuredClone(f.state())
        // The real missing-index route is now derived from its blueprint tags.
        // A configured victory group with its required wait tag removed remains
        // corrupt, and must reject without consuming entry state.
        const get = f.tables.get
        try {
            f.tables.get = function (name) {
                const rows = get.call(this, name)
                return name === 'worldmap_60064' ? rows.map((r) => (r.id === 5 ? { ...r, commonTag: '' } : r)) : rows
            }
            assert.throws(
                () => f.call('MultiCampaignCreate', { dungeon_id: gap.dungeonId, scene_type: 12 }),
                (e) => e.code === ErrorCode.GameConfig,
            )
        } finally {
            f.tables.get = get
        }
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
