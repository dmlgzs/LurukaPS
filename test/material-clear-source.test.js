import test from 'node:test'
import assert from 'node:assert/strict'
import { materialClearFixture } from './material-clear-fixture.js'
import { materialClearValue, materialClearRule } from '../src/material-clear-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const typed = (f) => f.read((s) => structuredClone(s.battlePass.seasons[s.battlePass.activeKey].tasks.week.counts))
test('10705 real material victory records one typed tuple,independent of boxes,restart and duplicate callbacks', () => {
    const f = materialClearFixture('material-clear-source')
    try {
        f.win(30101)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            1,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        const count = f.read((s) => s.materialClearRevision)
        f.call('MultiCampaignPlayerLoadFinish')
        f.login()
        assert.equal(
            f.read((s) => s.materialClearRevision),
            count,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        f.call('StaminaBoxGet', { box_id: f.chest().id, times: 2 })
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            1,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        f.win(30101)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            2,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 2)
        f.call('StaminaBoxGiveUp', { box_id: f.chest().id })
        assert.equal(typed(f)['material-clear:1:3:301'], 2)
        assert.equal(materialClearValue(f.tables, f.state(), [15010, 0, 3, 0, 0, 500]), 2)
    } finally {
        f.close()
    }
})

test('typed period source partitions tags and normal requests cannot manufacture a fresh victory', () => {
    const f = materialClearFixture('material-clear-tags')
    try {
        f.win(10101)
        f.win(20101)
        f.win(30101)
        assert.equal(typed(f)['material-clear:1:1:101'], 1)
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        assert.equal(
            Object.keys(typed(f)).filter((k) => k.startsWith('material-clear:') && k.split(':')[2] === '2').length,
            0,
        )
        const before = f.read((s) => s.materialClearRevision)
        for (let i = 0; i < 3; i++) f.call('ActivityGet')
        assert.equal(
            f.read((s) => s.materialClearRevision),
            before,
        )
        for (const tokens of [
            [15010, 0, 0, 0, 0, 1],
            [15010, 0, 999, 0, 0, 1],
            [15010, 0, 1, 201, 0, 1],
            [15010, 0, 1, 0, 1, 1],
            [15010, 99, 1, 0, 0, 1],
        ])
            assert.equal(materialClearRule(f.tables, tokens), false)
    } finally {
        f.close()
    }
})
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('fresh last10705 is one durable commit;late scene codec and SQLite failures preserve HP,lifetime and borrowed period COW', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const f = materialClearFixture(
        'material-clear-atomic',
        path.join(scratch, 'material-source-' + Date.now() + '.sqlite'),
    )
    try {
        f.win(30101)
        const last = f.readyLast(30101),
            before = f.state(),
            borrowed = f.read((s) => s.battlePass),
            borrowedJson = JSON.stringify(borrowed),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoMultiCampaignInfoSync') throw Error('material-source-scene-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.kill(last), /material-source-scene-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        assert.equal(JSON.stringify(borrowed), borrowedJson)
        f.store.db.exec(
            `CREATE TEMP TRIGGER material_clear_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'material-source-SQL'); END`,
        )
        try {
            assert.throws(() => f.kill(last), /material-source-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER material_clear_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(JSON.stringify(borrowed), borrowedJson)
        let commits = 0
        const save = f.store.savePlayer.run.bind(f.store.savePlayer)
        f.store.savePlayer.run = (...args) => {
            commits++
            return save(...args)
        }
        f.kill(last)
        assert.equal(commits, 1)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            2,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 2)
        const persisted = JSON.parse(
            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.id()).state,
        )
        assert.equal(persisted.materialDungeonRecords[30101].success_count, 2)
        assert.equal(
            persisted.battlePass.seasons[persisted.battlePass.activeKey].tasks.week.counts['material-clear:1:3:301'],
            2,
        )
        f.kill(last)
        assert.equal(commits, 1)
    } finally {
        f.close()
    }
})

test('same-second legacy completed-run recovery never reconstructs a new typed week from absent history or scalar15010', () => {
    const f = materialClearFixture('material-clear-legacy')
    try {
        f.win(30101)
        const at = f.run().end_time
        f.edit((s) => {
            const counts = s.battlePass.seasons[s.battlePass.activeKey].tasks.week.counts
            for (const k of Object.keys(counts)) if (k.startsWith('material-clear:')) delete counts[k]
            counts[15010] = 70
            delete s.entrust.run.battle_complete
        })
        f.time(at)
        f.login()
        assert.equal(f.run().battle_complete, true)
        assert.equal(typed(f)[15010], 70)
        assert.equal(Object.keys(typed(f)).filter((k) => k.startsWith('material-clear:')).length, 0)
        f.call('EndDungeonScene', { result: 3 })
        f.call('ActivityGet')
        assert.equal(Object.keys(typed(f)).filter((k) => k.startsWith('material-clear:')).length, 0)
        f.win(30101)
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        assert.equal(typed(f)[15010], 70)
    } finally {
        f.close()
    }
})

test('real clears stay in their victory week while a later multiple chest claim cannot move or multiply them', () => {
    const f = materialClearFixture('material-clear-week')
    try {
        const constants = new Map(f.tables.get('game').map((r) => [r.title, Number(r.value)])),
            hour = constants.get('DAILY_REFRESH_TIME'),
            weekday = constants.get('WEEKLY_REFRESH_TIME'),
            day = Math.floor((f.now() + (8 - hour) * 3600) / 86400),
            week = Math.floor((day + 4 - weekday) / 7),
            boundary = ((week + 1) * 7 - 4 + weekday) * 86400 - (8 - hour) * 3600
        f.time(boundary - 5)
        f.win(10101)
        assert.equal(typed(f)['material-clear:1:1:101'], 1)
        f.time(boundary + 1)
        f.call('StaminaBoxGet', { box_id: f.chest().id, times: 2 })
        assert.equal(typed(f)['material-clear:1:1:101'], undefined)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[10101].success_count),
            1,
        )
        f.win(10101)
        assert.equal(typed(f)['material-clear:1:1:101'], 1)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[10101].success_count),
            2,
        )
    } finally {
        f.close()
    }
})

test('a pet final blow uses the same actual death witness;ordinary nonfatal reports stay deferred', () => {
    const f = materialClearFixture('material-clear-pet-final')
    try {
        const last = f.readyLast(30101)
        let commits = 0
        const save = f.store.savePlayer.run.bind(f.store.savePlayer)
        f.store.savePlayer.run = (...args) => {
            commits++
            return save(...args)
        }
        f.kill(last, { damage: -1 })
        assert.equal(commits, 0)
        assert.equal(
            f.read((s) => s.materialDungeonRecords?.[30101]),
            undefined,
        )
        f.kill(last, { pet: true })
        assert.equal(commits, 1)
        assert.equal(
            f.read((s) => s.materialDungeonRecords[30101].success_count),
            1,
        )
        assert.equal(typed(f)['material-clear:1:3:301'], 1)
        assert(
            f.read((s) =>
                Object.values(s.combat.entities)
                    .filter((e) => e.object_id === last)
                    .every((e) => e.final_blow_guid === s.pets[0].guid),
            ),
        )
    } finally {
        f.close()
    }
})
