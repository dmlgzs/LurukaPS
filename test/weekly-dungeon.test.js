import { activeFormationManager } from '../src/trial-actors.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import {
    prepareWeeklyQuota,
    weeklyQuotaView,
    weeklyDungeonUnlocked,
    weeklyDungeonPolicy,
} from '../src/weekly-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
function fixture(name, store = new Store(':memory:'), { profile = 'sandbox', qualified = true } = {}) {
    let now = 1800000000,
        seq = 1,
        reportMs = 0,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    store.login(name, (id, account) => {
        const s = seedPlayer(tables, id, account, { mode: profile })
        const q = weeklyQuotaView(tables, s, now)
        const balance = s.player.attr_infos.attrs.find((r) => r.attr_id === 104)
        if (balance) balance.attr_val = String(q.limit)
        else s.player.attr_infos.attrs.push({ attr_id: 104, attr_val: String(q.limit) })
        return s
    })
    login()
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    if (qualified)
        edit((s) => {
            s.player.basic_info.lv = 70
            ;(s.taskRecords ??= []).push({ task_id: 106013, count: 1 })
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: String(now) }
            s.player.attr_infos.attrs.find((r) => r.attr_id === 3).attr_val = '500'
        })
    const run = () => state().entrust?.run
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
    const enter = (id = 35750) => call('MultiCampaignCreate', { dungeon_id: id, scene_type: 12 })
    const start = (id = 35750) => {
        enter(id)
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, run())
        edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        return { plan, packets: interact(plan.marker_id) }
    }
    const kill = (slot = 0, source) => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((r) => r.hp > 0)
        const target = enemies[slot]
        return call('BattleInfoReduce', {
            uint64_dic: [
                source ??
                    activeFormationManager(s).groups.find((g) => g.id === activeFormationManager(s).cur_group).control,
                target.uuid,
            ],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
            base_time: String(now * 1000 + ++reportMs),
        })
    }
    return {
        store,
        game,
        call,
        login,
        state,
        edit,
        run,
        interact,
        enter,
        start,
        kill,
        tick: (n) => (now += n),
        now: () => now,
    }
}

test('11850 weekly retries preserve quota, rewards and records while replaying the initial story and fresh boss', () => {
    for (const claimed of [true, false]) {
        const f = fixture('weekly-restart-' + claimed)
        try {
            f.edit((s) => {
                s.player.attr_infos.attrs.find((row) => row.attr_id === 104).attr_val = claimed ? '1' : '0'
            })
            const origin = structuredClone(f.state().world),
                { plan } = f.start()
            f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
            f.tick(3)
            const count = Object.values(f.state().combat.entities).filter((enemy) => enemy.hp > 0).length
            for (let i = 0; i < count; i++) f.kill()
            assert.equal(f.run().battle_complete, true)
            const chest = getEntrustCatalog(tables).chest(101, 'weekly')
            if (claimed) f.call('StaminaBoxGet', { box_id: chest.id, times: 1 })
            const saved = f.state(),
                old = saved.entrust.run
            f.tick(5)
            const packets = f.call('MultiCampaignRestart'),
                current = f.state()
            assert(packets.some((packet) => packet.id === 11850))
            assert.equal(f.run().instance_id, old.instance_id + 1)
            assert.equal(f.run().stage_index, 1)
            assert.equal(f.run().battle_complete, undefined)
            assert.equal(f.run().battle_start_time, undefined)
            assert.equal(f.run().chest_claimed, undefined)
            assert.deepEqual(f.run().return_world, old.return_world)
            assert.deepEqual(current.weeklyDungeonRecords, saved.weeklyDungeonRecords)
            assert.deepEqual(current.weeklyDungeonQuota, saved.weeklyDungeonQuota)
            assert.equal(current.player.attr_infos.attrs.find((row) => row.attr_id === 104).attr_val, '0')
            assert.deepEqual(current.player.sbag_infos, saved.player.sbag_infos)
            assert.deepEqual(current.player.attr_infos, saved.player.attr_infos)
            const instance = f.run().instance_id
            f.login()
            const again = f.call('MultiCampaignRestart')
            assert.equal(f.run().instance_id, instance)
            assert(!again.some((packet) => packet.id === 9103))
            f.call('MultiCampaignPlayerLoadFinish')
            const nextPlan = materialStoryPlan(tables, f.run())
            f.edit((s) => {
                s.world.pos = { ...nextPlan.pos }
            })
            const intro = f.interact(nextPlan.marker_id)
            assert(intro.some((packet) => packet.id === 11270))
            assert.equal(f.run().battle_start_time, undefined)
            f.call('PlayerStoryStop', { story_id: nextPlan.story_id, op: 1 })
            const enemies = Object.values(f.state().combat.entities).filter((enemy) => enemy.hp > 0)
            assert(enemies.length > 0 && enemies.every((enemy) => enemy.hp === enemy.max_hp))
            assert.equal(f.state().weeklyDungeonRecords[101].success_count, 1)
            f.call('CampaignQuit')
            assert.equal(f.state().world.map_id, origin.map_id)
            assert.deepEqual(f.state().world.pos, origin.pos)
        } finally {
            f.store.close()
        }
    }
})
test('weekly typed catalog resolves all18 current configurations without colliding with commission IDs', () => {
    const c = getEntrustCatalog(tables)
    for (const row of tables.get('dungeon_weekly')) {
        const route = c.get(row.id, 'weekly')
        assert.equal(route.weekly.id, row.id)
        assert.equal(route.dungeon.id, row.dungeonId)
        assert.equal(route.chest.type, 6)
        assert.equal(route.chest.worldFilter, '4|' + row.dungeonId)
        assert.deepEqual(
            c.stages(row.id, 'weekly').map((r) => r.type),
            [13, 50, 30],
        )
        const plan = materialStoryPlan(tables, {
            kind: 'weekly',
            entrust_id: row.id,
            dungeon_id: row.dungeonId,
            map_id: route.scene.id,
        })
        assert.equal(plan.map_id, route.scene.id)
        assert(tables.find('world_borthpos', plan.point_id))
        assert(plan.story_id > 0 && plan.boss_id > 0 && plan.range > 0)
        assert.equal(c.victoryObjects(row.id, 'weekly')[0].count, route.scene.id === 6900 ? 2 : 1)
    }
    assert.throws(
        () => c.get(101),
        (e) => e.code === ErrorCode.EntrustConfigNone,
    )
})
test('weekly zero quota still enters and two boss members must both die before one real clear', () => {
    const f = fixture('weekly-twin-zero')
    try {
        f.edit((s) => {
            ;(s.taskRecords ??= []).push({ task_id: 106027, count: 1 })
            s.player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val = '0'
        })
        const { plan } = f.start(35710)
        f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        const sql = () => f.store.db.prepare('SELECT total_changes() AS n').get().n
        const before = sql()
        f.kill()
        assert.equal(sql(), before, 'first member damage never writes SQL')
        assert.equal(f.run().battle_complete, undefined)
        f.tick(5)
        f.kill()
        assert.equal(f.run().battle_complete, true)
        assert.equal(f.state().weeklyDungeonRecords[201].success_count, 1)
        assert.equal(f.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, '0')
        const monsters = f.state().entrust.run.scene_objects.find((r) => r.obj_id === plan.boss_id)
        assert.equal(monsters.active, false)
        assert.deepEqual(monsters.expand_data.battle_group.world_indexes, [])
        assert(Object.values(f.state().combat.entities).every((r) => r.hp === 0))
        f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(f.state().weeklyDungeonRecords[201].success_count, 1)
    } finally {
        f.store.close()
    }
})
test('weekly intro wrong END and codec failure preserve active run, position, quota and receipts atomically', () => {
    const f = fixture('weekly-codec-rollback')
    try {
        f.enter()
        f.call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, f.run())
        f.edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        const old = f.state(),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoPlayerStoryStart') throw Error('injected11270codec')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.interact(plan.marker_id), /injected11270codec/)
        f.game.packet = packet
        assert.deepEqual(f.state(), old)
        f.interact(plan.marker_id)
        const playing = f.state()
        assert.throws(
            () => f.call('PlayerStoryStop', { story_id: plan.story_id + 1, op: 1 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), playing)
        f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        const started = f.run().battle_start_time
        f.tick(7)
        f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        assert.equal(f.run().battle_start_time, started)
    } finally {
        f.store.close()
    }
})
test('weekly pending intro and first zero quota survive real SQLite close/reopen; second account is isolated', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-b24-')),
        file = path.join(folder, 'state.db')
    const stores = []
    try {
        const firstStore = new Store(file)
        stores.push(firstStore)
        const first = fixture('weekly-disk', firstStore)
        first.edit((s) => {
            delete s.weeklyDungeonQuota
            s.player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val = '0'
        })
        first.login()
        assert.equal(first.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, '0')
        const { plan } = first.start()
        firstStore.close()
        const secondStore = new Store(file)
        stores.push(secondStore)
        const second = fixture('weekly-disk', secondStore)
        assert.equal(second.run().materialStory.phase, 'playing')
        assert.equal(second.run().battle_start_time, undefined)
        assert.equal(second.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, '0')
        second.call('MultiCampaignPlayerLoadFinish')
        second.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        second.tick(1)
        second.kill()
        secondStore.flushPending()
        secondStore.close()
        const thirdStore = new Store(file)
        stores.push(thirdStore)
        const third = fixture('weekly-disk', thirdStore)
        assert.equal(third.state().weeklyDungeonRecords[101].success_count, 1)
        const other = fixture('weekly-disk-other', thirdStore)
        assert.equal(other.run(), undefined)
        assert.equal(other.state().weeklyDungeonRecords, undefined)
        assert.equal(other.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, '3')
    } finally {
        for (const store of stores) if (store.db.open) store.close()
        const resolved = path.resolve(folder)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
test('weekly LOCAL quota preserves first zero/GM balances and sets once at aligned Monday04 epoch', () => {
    const base = () => ({ player: { attr_infos: { attrs: [] } } })
    const now = Date.parse('2026-10-19T04:00:00+08:00') / 1000
    for (const amount of [undefined, 0, 7, 0xffffffffffffffffn]) {
        const s = base()
        if (amount !== undefined) s.player.attr_infos.attrs.push({ attr_id: 104, attr_val: String(amount) })
        assert.equal(prepareWeeklyQuota(tables, s, now), true)
        assert.equal(weeklyQuotaView(tables, s, now).amount, BigInt(amount ?? 3))
        assert.equal(prepareWeeklyQuota(tables, s, now + 1), false)
        assert.equal(prepareWeeklyQuota(tables, s, now - 1), false)
        assert.equal(weeklyQuotaView(tables, s, now - 1).amount, BigInt(amount ?? 3))
        assert.equal(prepareWeeklyQuota(tables, s, now + 604800), true)
        assert.equal(weeklyQuotaView(tables, s, now + 604800).amount, 3n)
        assert.equal(prepareWeeklyQuota(tables, s, now + 604800), false)
    }
    for (const invalid of [
        null,
        [],
        {},
        { schemaVersion: 1, policy: 'set-to-limit-v1', periodStart: now + 1, initializedAt: now },
    ]) {
        const s = base()
        s.weeklyDungeonQuota = invalid
        assert.throws(
            () => prepareWeeklyQuota(tables, s, now),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
    const s = base()
    s.player.attr_infos.attrs = [
        { attr_id: 104, attr_val: '1' },
        { attr_id: 104, attr_val: '2' },
    ]
    assert.throws(
        () => prepareWeeklyQuota(tables, s, now),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
test('9510 weekly unearned normal system rejects until both task/commission conditions; own dungeon rules remain separate', () => {
    const f = fixture('weekly-system-gate', new Store(':memory:'), { profile: 'normal', qualified: false })
    try {
        const reject = (code) => {
            const before = f.state()
            assert.throws(
                () => f.enter(),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        reject(ErrorCode.SystemLock)
        f.edit((s) => {
            s.player.basic_info.lv = 70
            s.taskRecords = [...(s.taskRecords ?? []), { task_id: 106013, count: 1 }]
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 0 }
        })
        f.call('GetRechargePopupData', {})
        reject(ErrorCode.SystemLock)
        f.edit((s) => {
            s.entrust.records[8].entrust_star = 1
        })
        const ps = f.call('GetRechargePopupData', {})
        assert(
            ps
                .filter((p) => p.id === 10600)
                .flatMap((p) => protocol.decode(protocol.byId.get(10600).rsp, p.payload).unlock_id ?? [])
                .includes(1735),
        )
        f.edit((s) => {
            s.player.basic_info.lv = 1
        })
        reject(ErrorCode.EntrustUnlock)
        f.edit((s) => {
            s.player.basic_info.lv = 70
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '0'
            delete s.weeklyDungeonQuota
        })
        f.enter()
        assert.equal(f.run().kind, 'weekly')
        assert.equal(weeklyQuotaView(tables, f.state(), f.now()).amount, 0n)
    } finally {
        f.store.close()
    }
})

test('current weekly trigger identity and source precedence reject stale or ambiguous data and retain the required LOCAL compatibility gate', () => {
    const source = (change) => ({
        get(name) {
            return change(name, structuredClone(tables.get(name)))
        },
        find(name, id) {
            return this.get(name).find((r) => r.id === Number(id))
        },
    })
    const route = getEntrustCatalog(tables).get(101, 'weekly'),
        run = { kind: 'weekly', entrust_id: 101, dungeon_id: route.dungeon.id, map_id: route.scene.id },
        plan = materialStoryPlan(tables, run)
    assert.equal(plan.local_trigger_source.interact_id, 4012)
    assert.equal(plan.range, 1000)
    const altered = source((name, rows) => {
        if (name === 'worldmap_' + run.map_id) rows.find((r) => r.id === plan.marker_id).interactOptions = '4013'
        return rows
    })
    assert.throws(
        () => materialStoryPlan(altered, run),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const enabled = weeklyDungeonPolicy.intro.enabled
    try {
        weeklyDungeonPolicy.intro.enabled = false
        assert.throws(
            () => materialStoryPlan(tables, run),
            (e) => e.code === ErrorCode.FunctionClosed,
            'current bound missing-trigger alias still requires its explicit LOCAL policy',
        )
    } finally {
        weeklyDungeonPolicy.intro.enabled = enabled
    }
    const duplicate = source((name, rows) => {
        if (name === 'worldmap_' + run.map_id) rows.push({ ...rows.find((r) => r.id === plan.marker_id) })
        return rows
    })
    assert.throws(
        () => materialStoryPlan(duplicate, run),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const zero = source((name, rows) => {
        if (name === 'dungeon_scene') rows.find((r) => r.id === run.map_id).intParam += '|bossTriggerID#0'
        return rows
    })
    assert.throws(
        () => materialStoryPlan(zero, run),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => materialStoryPlan(tables, { kind: 'weekly', map_id: run.map_id }),
        (e) => e.code === ErrorCode.GameConfig,
    )
})

test('weekly pet final blow records real damage/clear and failed9513 codec rolls the death back', () => {
    const f = fixture('weekly-pet-death')
    try {
        const { plan } = f.start()
        f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        const snapshot = f.state(),
            hp = Object.values(snapshot.combat.entities)[0].hp,
            pet = snapshot.pets[0].guid
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoMultiCampaignInfoSync') throw Error('injected9513codec')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.kill(0, pet), /injected9513codec/)
        f.game.packet = packet
        assert.deepEqual(f.state(), snapshot)
        f.tick(1)
        f.kill(0, pet)
        assert.equal(f.state().weeklyDungeonRecords[101].success_count, 1)
        assert.equal(f.run().damage_total, String(hp))
        assert.equal(Object.values(f.state().combat.entities)[0].final_blow_guid, pet)
    } finally {
        f.store.close()
    }
})
test('weekly idle epoch tick pushes104 once and codec failure rolls back reset without a per-tick write', () => {
    const f = fixture('weekly-epoch-tick')
    try {
        const id = f.state().player.basic_info.id
        f.edit((s) => {
            s.player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val = '0'
        })
        const period = weeklyQuotaView(tables, f.state(), f.now()).periodStart
        f.tick(period + 604800 - f.now())
        const before = f.state(),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoSyncPlayerData') throw Error('injected-quota-codec')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.game.tick(id), /injected-quota-codec/)
        f.game.packet = packet
        assert.deepEqual(f.state(), before)
        const result = f.game.tick(id)
        const entry = protocol.byName.get('CSProtoSyncPlayerData')
        assert(
            result
                .filter((p) => p.id === entry.id)
                .map((p) => protocol.decode(entry.rsp, p.payload))
                .some((p) => p.attr_infos?.attrs?.some((a) => a.attr_id === 104 && a.attr_val === '3')),
        )
        const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        f.game.tick(id)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        assert.equal(weeklyQuotaView(tables, f.state(), f.now()).amount, 3n)
    } finally {
        f.store.close()
    }
})
test('9510 weekly real9133 marker starts11270, waits real11271 END, records victory without charging104', () => {
    const f = fixture('weekly-full')
    try {
        const { plan, packets } = f.start()
        assert.equal(f.run().kind, 'weekly')
        assert.equal(f.run().materialStory.phase, 'playing')
        assert.equal(f.run().battle_start_time, undefined)
        assert(packets.some((p) => p.id === 11270))
        assert.equal(f.state().world.point_id, plan.point_id)
        assert.equal(weeklyQuotaView(tables, f.state(), f.now()).amount, 3n)
        f.tick(4)
        const stop = f.call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        assert(!stop.some((p) => p.id === 11271), '11271 has no response')
        assert.equal(f.run().battle_start_time, f.now())
        f.tick(2)
        f.kill()
        assert.equal(f.run().battle_complete, true)
        assert.equal(f.run().star_mask, 7)
        assert.equal(f.state().weeklyDungeonRecords[101].star, 7)
        assert.equal(f.state().entrust.records[101], undefined)
        assert.equal(weeklyQuotaView(tables, f.state(), f.now()).amount, 3n)
        assert(weeklyDungeonUnlocked('13117#101#1', f.state()))
        const packets2 = f.login(),
            e = protocol.byName.get('CSProtoMultiCampaignInfoSync')
        const values = packets2.filter((p) => p.id === e.id).flatMap((p) => protocol.decode(e.rsp, p.payload).camp)
        assert(values.some((r) => r.dungeon_id === 35750 && r.star === 7))
        f.call('CampaignQuit')
        f.enter()
        assert.equal(f.run().battle_complete, undefined)
        assert.equal(f.run().stage_index, 1)
        assert(Object.values(f.state().combat.entities).every((r) => r.hp > 0))
    } finally {
        f.store.close()
    }
})
