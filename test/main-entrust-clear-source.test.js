import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainEntrustFixture } from './main-entrust-clear-fixture.js'
import {
    mainEntrustClearRule,
    mainEntrustClearPeriodValue,
    recordMainEntrustVictory,
} from '../src/main-entrust-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const counts = (f) =>
    f.read((state) => structuredClone(state.battlePass.seasons[state.battlePass.activeKey].tasks.week.counts))
const value = (f) => counts(f)['main-entrust-clear'] ?? 0

test('12251 source records repeated actual main wins,independent of receipts,boxes and reconstruction', () => {
    const f = mainEntrustFixture('main-clear-source')
    try {
        for (let index = 0; index < 5; index++) f.win(1)
        assert.equal(value(f), 5)
        assert.equal(
            f.read((state) => state.mainEntrustClearRevision),
            5,
        )
        assert.equal(
            f.read((state) => Object.keys(state.entrust.records).length),
            1,
        )
        const old = f.read((state) => state.mainEntrustClearRevision)
        f.call('MultiCampaignPlayerLoadFinish')
        f.login()
        assert.equal(
            f.read((state) => state.mainEntrustClearRevision),
            old,
        )
        const times = f.chest().multimes === 1 ? 2 : 1
        f.call('StaminaBoxGet', { box_id: f.chest().id, times })
        assert.equal(value(f), 5)
        f.win(2)
        assert.equal(value(f), 6)
        assert.equal(
            f.read((state) => Object.keys(state.entrust.records).length),
            2,
        )
        f.call('ActivityGet')
        assert.equal(value(f), 6)
    } finally {
        f.close()
    }
})

test('main final-pet-death is one durable commit;codec and SQLite rollback preserve old record and flat period COW', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const f = mainEntrustFixture('main-clear-atomic', path.join(scratch, 'main-source-' + Date.now() + '.sqlite'))
    try {
        f.win(1)
        const last = f.readyLast(1)
        let commits = 0
        const save = f.store.savePlayer.run.bind(f.store.savePlayer)
        f.store.savePlayer.run = (...args) => {
            commits++
            return save(...args)
        }
        f.kill(last, { damage: -1 })
        assert.equal(commits, 0)
        const before = f.state(),
            borrowed = f.read((state) => [state.entrust.records, state.battlePass]),
            serialized = JSON.stringify(borrowed)
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoWorldMapSync') throw Error('main-clear-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.kill(last, { pet: true }), /main-clear-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        assert.equal(JSON.stringify(borrowed), serialized)
        f.store.db.exec(
            `CREATE TEMP TRIGGER main_clear_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'main-clear-SQL'); END`,
        )
        try {
            assert.throws(() => f.kill(last, { pet: true }), /main-clear-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER main_clear_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(JSON.stringify(borrowed), serialized)
        assert.equal(commits, 1) // attempted SQL commit failed atomically
        f.kill(last, { pet: true })
        assert.equal(commits, 2)
        assert.equal(value(f), 2)
        assert.equal(
            f.read((state) => state.mainEntrustClearRevision),
            2,
        )
        const saved = JSON.parse(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.id()).state)
        assert.equal(saved.mainEntrustClearRevision, 2)
        assert.equal(saved.battlePass.seasons[saved.battlePass.activeKey].tasks.week.counts['main-entrust-clear'], 2)
        f.kill(last, { pet: true })
        assert.equal(commits, 2)
        assert(
            f.read((state) =>
                Object.values(state.combat.entities)
                    .filter((enemy) => enemy.object_id === last)
                    .every((enemy) => enemy.final_blow_guid === state.pets[0].guid),
            ),
        )
    } finally {
        f.close()
    }
})

test('same-second legacy main recovery ignores old scalar12251 and absent receipt instead of backfilling this week', () => {
    const f = mainEntrustFixture('main-clear-old-run')
    try {
        f.win(1)
        const at = f.run().end_time
        f.edit((state) => {
            const target = state.battlePass.seasons[state.battlePass.activeKey].tasks.week.counts
            delete target['main-entrust-clear']
            target[12251] = 80
            delete state.mainEntrustClearRevision
            delete state.entrust.run.battle_complete
        })
        f.time(at)
        f.login()
        assert.equal(f.run().battle_complete, true)
        assert.equal(value(f), 0)
        assert.equal(counts(f)[12251], 80)
        assert.equal(
            f.read((state) => state.mainEntrustClearRevision),
            undefined,
        )
        f.call('ActivityGet')
        f.win(1)
        assert.equal(value(f), 1)
        assert.equal(counts(f)[12251], 80)
    } finally {
        f.close()
    }
})

test('main clear week and configured namespace stay separate from materials,other modes and invalid selectors', () => {
    const f = mainEntrustFixture('main-clear-domain')
    try {
        const constants = new Map(f.tables.get('game').map((row) => [row.title, Number(row.value)]))
        const hour = constants.get('DAILY_REFRESH_TIME'),
            weekday = constants.get('WEEKLY_REFRESH_TIME')
        const day = Math.floor((f.now() + (8 - hour) * 3600) / 86400),
            week = Math.floor((day + 4 - weekday) / 7)
        const boundary = ((week + 1) * 7 - 4 + weekday) * 86400 - (8 - hour) * 3600
        f.time(boundary - 5)
        f.win(1)
        assert.equal(value(f), 1)
        f.time(boundary + 1)
        f.call('ActivityGet')
        assert.equal(value(f), 0)
        f.win(1)
        assert.equal(value(f), 1)
        const state = f.state(),
            run = f.run(),
            route = f.catalog.get(1)
        for (const patch of [
            { kind: 'material' },
            { kind: 'weekly' },
            { kind: 'repeat' },
            { kind: 'story' },
            { dungeon_id: 999999 },
            { map_id: 999999 },
            { instance_id: 0 },
            { entrust_id: 10101 },
        ])
            assert.throws(
                () =>
                    recordMainEntrustVictory(
                        f.tables,
                        structuredClone(state),
                        { ...run, ...patch },
                        route,
                        f.now(),
                        true,
                    ),
                (error) => error.code === ErrorCode.GameConfig,
            )
        for (const tokens of [
            [12251, 0],
            [12251, 5, 1],
            [12251, null],
            [12251, -1],
        ])
            assert.equal(mainEntrustClearRule(f.tables, tokens), false)
        assert.equal(mainEntrustClearRule(f.tables, [12251, 7]), true)
        assert.equal(mainEntrustClearPeriodValue(f.tables, { 12251: 100 }, [12251, 5]), 0)
        assert.throws(
            () => mainEntrustClearPeriodValue(f.tables, { 'main-entrust-clear': null }, [12251, 5]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        f.material.win(10101)
        assert.equal(value(f), 1)
        assert.equal(
            f.read((saved) => saved.mainEntrustClearRevision),
            2,
        )
        assert.equal(counts(f)['material-clear:1:1:101'], 1)
    } finally {
        f.close()
    }
})
