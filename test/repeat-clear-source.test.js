import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repeatClearFixture } from './repeat-clear-fixture.js'
import {
    repeatClearModeSupported,
    repeatClearRule,
    repeatClearPeriodValue,
    recordRepeatClear,
} from '../src/repeat-event-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const target = 10106,
    key = 'repeat-clear:10001:10106:1'
const season = (f) => f.read((state) => state.battlePass.activeKey)
const counts = (f) =>
    f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey].tasks.forever.counts))
const count = (f) => counts(f)[key] ?? 0
const scratch = () => {
    const dir = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

test('real first five repeat levels unlock the current target;reentry,first-pass,multiple chest and exit never replace a victory', () => {
    const f = repeatClearFixture('repeat-source-chain')
    try {
        f.unlockThrough(target - 1)
        assert.equal(count(f), 0)
        for (let level = 10101; level < target; level++)
            assert(f.read((state) => state.repeatEvent.levels[`10001:${level}`].mode_save_data[0].win_count > 0))
        f.win(target)
        assert.equal(count(f), 1)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(count(f), 1)
        f.call('StaminaBoxGet', { box_id: f.chest().id, times: 3 })
        assert.equal(count(f), 1)
        f.begin(target)
        assert.equal(count(f), 1)
        f.finish()
        assert.equal(count(f), 2)
        const revision = f.read((state) => state.repeatClearRevision)
        f.call('MultiCampaignPlayerLoadFinish')
        f.exit()
        f.login()
        assert.equal(count(f), 2)
        assert.equal(
            f.read((state) => state.repeatClearRevision),
            revision,
        )
    } finally {
        f.close()
    }
})

test('repeat pet final death is durable once and failed codec/SQL keep pending,repeat mode and BP COW intact', () => {
    const f = repeatClearFixture(
        'repeat-source-atomic',
        path.join(scratch(), 'repeat-source-' + Date.now() + '.sqlite'),
    )
    try {
        f.unlockThrough(target - 1)
        const last = f.readyLast(target)
        let attempts = 0
        const save = f.store.savePlayer.run.bind(f.store.savePlayer)
        f.store.savePlayer.run = (...args) => {
            attempts++
            return save(...args)
        }
        f.kill(last, { damage: -1 })
        assert.equal(attempts, 0)
        const before = f.state(),
            pending = f.store.pending.get(f.id()),
            borrowed = f.read((state) => [state.repeatEvent, state.battlePass]),
            borrowedJson = JSON.stringify(borrowed)
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoWorldMapSync') throw Error('repeat-source-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.kill(last, { pet: true }), /repeat-source-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.id()), pending)
        assert.equal(JSON.stringify(borrowed), borrowedJson)
        f.store.db.exec(
            `CREATE TEMP TRIGGER repeat_source_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'repeat-source-SQL'); END`,
        )
        try {
            assert.throws(() => f.kill(last, { pet: true }), /repeat-source-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER repeat_source_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.id()), pending)
        assert.equal(JSON.stringify(borrowed), borrowedJson)
        f.kill(last, { pet: true })
        assert.equal(attempts, 2) // one failed SQL attempt and one successful durable commit
        assert.equal(count(f), 1)
        const disk = JSON.parse(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.id()).state)
        assert.equal(
            disk.repeatClearRevision,
            f.read((state) => state.repeatClearRevision),
        )
        assert.equal(disk.battlePass.seasons[disk.battlePass.activeKey].tasks.forever.counts[key], 1)
        f.kill(last, { pet: true })
        assert.equal(attempts, 2)
        assert.equal(count(f), 1)
    } finally {
        f.close()
    }
})

test('same-second old completed repeat recovery does not backfill from win_count,scalar81000 or absent flags', () => {
    const f = repeatClearFixture('repeat-source-old')
    try {
        f.unlockThrough(target)
        const at = f.run().end_time
        f.edit((state) => {
            const period = state.battlePass.seasons[state.battlePass.activeKey].tasks.forever.counts
            for (const name of Object.keys(period)) if (name.startsWith('repeat-clear:')) delete period[name]
            period[81000] = 99
            delete state.repeatClearRevision
            delete state.entrust.run.battle_complete
        })
        f.time(at)
        f.login()
        assert.equal(f.run().battle_complete, true)
        assert.equal(count(f), 0)
        assert.equal(counts(f)[81000], 99)
        assert.equal(
            f.read((state) => state.repeatClearRevision),
            undefined,
        )
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(count(f), 0)
        f.win(target)
        assert.equal(count(f), 1)
        assert.equal(counts(f)[81000], 99)
    } finally {
        f.close()
    }
})

test('season identity isolates repeat facts while genuine lifetime passes remain and only the next new clear starts the new ledger', () => {
    const file = path.join(scratch(), 'repeat-season-' + Date.now() + '.sqlite')
    let f = repeatClearFixture('repeat-source-season', file)
    try {
        f.unlockThrough(target)
        const previous = season(f),
            at = f.now()
        assert.equal(count(f), 1)
        f.close()
        f = repeatClearFixture('repeat-source-season', file, {
            now: at + 1,
            configureTables(tables) {
                tables.cache.set(
                    'battle_pass',
                    tables.get('battle_pass').map((row) => ({ ...row, startTime: '20260201-040000' })),
                )
            },
        })
        assert.notEqual(season(f), previous)
        assert.equal(count(f), 0)
        assert(f.read((state) => state.repeatEvent.levels['10001:10106'].mode_save_data[0].win_count > 0))
        assert.equal(
            f.read((state) => state.battlePass.seasons[previous].tasks.forever.counts[key]),
            1,
        )
        f.win(target)
        assert.equal(count(f), 1)
        assert.equal(
            f.read((state) => state.battlePass.seasons[previous].tasks.forever.counts[key]),
            1,
        )
    } finally {
        f.close()
    }
})

test('other configured levels use the same positive-target rule;nonzero,multi-mode,foreign namespaces and scalar history stay closed', () => {
    const level = 10105,
        otherKey = 'repeat-clear:10001:10105:1'
    const f = repeatClearFixture('repeat-source-generic', ':memory:', {
        configureTables(tables) {
            tables.cache.set(
                'battle_pass_task',
                tables
                    .get('battle_pass_task')
                    .map((row) =>
                        row.condition.startsWith('81000|')
                            ? { ...row, condition: `81000|${level}|0|2`, param: 2 }
                            : row,
                    ),
            )
        },
    })
    try {
        assert(repeatClearRule(f.tables, [81000, level, 0, 7]))
        for (const tokens of [
            [81000, level, 1, 1],
            [81000, level, 2, 1],
            [81000, 0, 0, 1],
            [81000, level, 0, 0],
            [81000, level, 0, 1, 2],
        ])
            assert.equal(repeatClearRule(f.tables, tokens), false)
        const row = f.current.find('repeat_event_level', level)
        assert.equal(repeatClearModeSupported({ ...row, isHardOpen: 1, hardDungeonId: 999999 }), false)
        f.unlockThrough(level)
        f.win(level)
        assert.equal(counts(f)[otherKey], 2)
        assert.equal(count(f), 0)
        const sourceRevision = f.read((state) => state.repeatClearRevision),
            active = f.run(),
            route = f.catalog.get(active.entrust_id, 'repeat')
        for (const patch of [
            { kind: 'material' },
            { kind: 'entrust' },
            { kind: 'weekly' },
            { kind: 'story' },
            { dungeon_id: 1 },
            { instance_id: 0 },
            { repeat_event: { ...active.repeat_event, activity: 999999 } },
            { repeat_event: { ...active.repeat_event, mode: 0 } },
        ])
            assert.throws(
                () =>
                    recordRepeatClear(
                        f.tables,
                        structuredClone(f.state()),
                        { ...active, ...patch },
                        route,
                        f.now(),
                        true,
                    ),
                (error) => error.code === ErrorCode.GameConfig,
            )
        assert.equal(repeatClearPeriodValue(f.tables, { 81000: 99 }, [81000, level, 0, 2]), 0)
        assert.throws(
            () => repeatClearPeriodValue(f.tables, { 'repeat-clear:10001:010105:1': 1 }, [81000, level, 0, 2]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        f.otherWin('entrust', 1)
        f.otherWin('material', 10101)
        assert.equal(
            f.read((state) => state.repeatClearRevision),
            sourceRevision,
        )
        assert.equal(counts(f)[otherKey], 2)
    } finally {
        f.close()
    }
})

test('a genuine zero-star repeat win is still one completion rather than a star or reward predicate', () => {
    const f = repeatClearFixture('repeat-source-zero-star')
    try {
        f.unlockThrough(target - 1)
        const last = f.readyLast(target),
            active = f.run(),
            route = f.catalog.get(active.entrust_id, 'repeat')
        const actor = f.read((state) => ({
            enemy: Object.values(state.combat.entities).find((row) => row.object_id === last && row.hp > 0).uuid,
            hero: state.player.heros_info.battle_infos.find((row) => row.hp > 0),
        }))
        f.call('BattleInfoReduce', {
            uint64_dic: [actor.enemy, actor.hero.hero_id],
            base_time: '0',
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -actor.hero.hp } }],
        })
        const limits = String(route.dungeon.challenge)
            .split('|')
            .map((part) => part.split('#').map(Number))
            .filter(([kind]) => kind === 3006)
            .map(([, seconds]) => seconds)
        f.time(f.now() + Math.max(...limits) + 1)
        f.kill(last, { pet: true })
        assert.equal(f.run().battle_complete, true)
        assert.equal(f.run().star, 0)
        assert.equal(count(f), 1)
    } finally {
        f.close()
    }
})
