import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { ErrorCode } from '../src/error-codes.js'
function fixture(name, file = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(file),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.player.basic_info.lv = 70
        ;(s.taskRecords ??= []).push({ task_id: 106013, count: 1 })
        s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
        s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: String(now) }
    })
    const start = (dungeonId = 35750) => {
        call('MultiCampaignCreate', { dungeon_id: dungeonId, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, state().entrust.run)
        edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: plan.marker_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        now += 3
        return structuredClone(state().dailyActive)
    }
    const kill = () => {
        const s = state(),
            enemy = Object.values(s.combat.entities).find((r) => r.hp > 0)
        return call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            base_time: '0',
        })
    }
    const win = () => {
        const before = start()
        while (Object.values(state().combat.entities).some((r) => r.hp > 0)) {
            kill()
        }
        assert.equal(state().entrust.run.battle_complete, true)
        return before
    }
    return {
        tables,
        protocol,
        store,
        session,
        game,
        state,
        edit,
        call,
        start,
        kill,
        win,
        now: () => now,
        setNow: (value) => {
            now = value
        },
    }
}
test('292 already supports real weekly entry, two victories and the corresponding6600 weekly task', () => {
    const f = fixture('b225-existing-weekly-active')
    try {
        const catalog = getEntrustCatalog(f.tables)
        const routes = f.tables
            .get('dungeon_weekly')
            .map((row) => ({ id: row.id, stages: catalog.stages(row.id, 'weekly').map((s) => s.type) }))
        assert.equal(routes.length, 12)
        assert(routes.every((row) => JSON.stringify(row.stages) === '[13,50,30]'))
        f.win()
        assert.equal(f.state().dailyActive.week.counts[15004], 1)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().dailyActive.week.counts[15004], 1)
        f.call('MultiCampaignQuit')
        f.win()
        assert.equal(f.state().dailyActive.week.counts[15004], 2)
        const quota = f.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val
        f.call('GetActiveReward', { u32s: [1006] })
        assert.equal(f.state().dailyActive.week.active, 20)
        f.call('GetActiveReward', { u32s: [1006] })
        assert.equal(f.state().dailyActive.week.active, 20)
        assert.equal(f.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, quota)
    } finally {
        f.store.close()
    }
})
test('same-second legacy settlement recovery without a new death must not create a current weekly active event', () => {
    const f = fixture('b225-same-second-weekly-recovery')
    try {
        const before = f.win()
        const original = f.state()
        // Explicit negative recovery fixture: reuse only a real completed battle,
        // but reconstruct its older pre-receipt save shape and earlier period ledger.
        // This is not a new win or imported positive qualification assertion.
        f.edit((s) => {
            s.dailyActive = structuredClone(before)
            s.entrust.run.status = 2
            delete s.entrust.run.battle_complete
            delete s.weeklyDungeonRecords
        })
        const prior = f.state().dailyActive.week.counts[15004] ?? 0
        assert.equal(f.state().entrust.run.end_time, f.now())
        f.call('EnterDungeonScene', { scene_id: original.entrust.run.map_id })
        const after = f.state().dailyActive.week.counts[15004] ?? 0
        assert.equal(after, prior)
    } finally {
        f.store.close()
    }
})

test('weekly twin partial death and final-sync codec failure cannot leak a new active event; retry counts once', () => {
    const f = fixture('b225-twin-active-codec')
    try {
        f.edit((s) => {
            s.taskRecords.push({ task_id: 106027, count: 1 })
        })
        f.start(35710)
        const enemies = Object.values(f.state().combat.entities).filter((r) => r.hp > 0)
        assert.equal(enemies.length, 2)
        f.kill()
        assert.equal(f.state().dailyActive.week.counts[15004] ?? 0, 0)
        const before = f.state(),
            pending = f.store.pending.get(f.session.id)
        const root = pending?.state,
            week = root?.dailyActive?.week
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoMultiCampaignInfoSync') throw Error('b225-final-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.kill(), /b225-final-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(pending?.state, root)
        assert.equal(root?.dailyActive?.week, week)
        f.kill()
        assert.equal(f.state().dailyActive.week.counts[15004], 1)
        f.call('EndDungeonScene', { result: 3 })
        f.call('EnterDungeonScene', { scene_id: f.state().entrust.run.map_id })
        assert.equal(f.state().dailyActive.week.counts[15004], 1)
    } finally {
        f.store.close()
    }
})

test('a new weekly period receives no event from the old completed run and only credits its next real victory', () => {
    const f = fixture('b225-weekly-period')
    try {
        f.win()
        const week = f.state().dailyActive.week.key
        f.setNow(f.now() + 604800)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().dailyActive.week.key, week + 1)
        assert.equal(f.state().dailyActive.week.counts[15004] ?? 0, 0)
        f.call('EnterDungeonScene', { scene_id: f.state().entrust.run.map_id })
        assert.equal(f.state().dailyActive.week.counts[15004] ?? 0, 0)
        f.call('MultiCampaignQuit')
        f.win()
        assert.equal(f.state().dailyActive.week.counts[15004], 1)
        assert.throws(
            () => f.call('GetActiveReward', { u32s: [1006] }),
            (e) => e.code === ErrorCode.kActiveTaskNotComplete,
        )
    } finally {
        f.store.close()
    }
})

test('weekly real-win progress survives claim SQL rollback and SQLite reopen without replay or cross-account credit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b225-weekly-'))
    const filename = path.join(directory, 'test.sqlite')
    let f = fixture('b225-durable-weekly', filename)
    try {
        f.win()
        f.call('MultiCampaignQuit')
        f.win()
        const before = f.state(),
            pending = f.store.pending.get(f.session.id)
        const root = pending?.state,
            counts = root?.dailyActive?.week?.counts
        const disk = f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state
        f.store.db.exec(
            "CREATE TEMP TRIGGER b225_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'b225-sql'); END",
        )
        try {
            assert.throws(() => f.call('GetActiveReward', { u32s: [1006] }), /b225-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER b225_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(pending?.state, root)
        assert.equal(root?.dailyActive?.week?.counts, counts)
        assert.equal(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state, disk)
        f.call('GetActiveReward', { u32s: [1006] })
        assert.equal(f.state().dailyActive.week.active, 20)
        f.store.close()
        f = fixture('b225-durable-weekly', filename)
        assert.equal(f.state().dailyActive.week.counts[15004], 2)
        assert.equal(f.state().dailyActive.week.active, 20)
        f.call('GetActiveReward', { u32s: [1006] })
        assert.equal(f.state().dailyActive.week.active, 20)
        const other = fixture('b225-other-weekly', filename)
        try {
            assert.equal(other.state().dailyActive.week.counts[15004] ?? 0, 0)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('b225-weekly-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
