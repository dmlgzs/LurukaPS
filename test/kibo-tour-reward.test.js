import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tourFixture, tables } from './kibo-tour-fixture.js'
import { maximumLevel } from '../src/handlers/progression.js'
import { ErrorCode } from '../src/error-codes.js'
const ledger = (f) => f.state().activities[8001].kiboTour
const start = (f, id = 1001, ids = f.petIds()) =>
    f.call('StartKiboTour', { activity_id: 8001, tour_id: id, pet_id_list: ids })
const claim = (f, id = 1001) => f.call('KiboTourReward', { activity_id: 8001, tour_id: id })
const itemCount = (s) => s.player.sbag_infos.items.filter((r) => r.itemid === 502000).reduce((n, r) => n + r.itemnum, 0)
const totalXp = (pet) =>
    tables
        .get('pet_level')
        .filter((r) => r.lv < pet.lv)
        .reduce((n, r) => n + r.exp, pet.exp ?? 0)
function matchingPair(f) {
    const targets = f.game.activities.tours.rows.get(1001).elements
    const matching = (pet) =>
        String(tables.find('pet', pet.config_id).element)
            .split('|')
            .map(Number)
            .some((e) => targets.includes(e))
    const pets = f.state().pets.filter((p) => !p.trial && !p.trail && p.type !== 2)
    const yes = pets.find(matching),
        no = pets.find((p) => !matching(p))
    assert.ok(yes && no)
    return [yes.guid, no.guid]
}
test('10408 grants actual fixed items and per-pet preview XP once, synchronizes before ACK, and never stores virtual pet XP as a global balance', () => {
    const f = tourFixture('tour-reward-real')
    try {
        let ids = matchingPair(f)
        f.edit((s) => {
            ids = ids.map((id, index) => {
                const pet = s.pets.find((p) => p.guid === id)
                pet.guid = ((2n << 56n) + BigInt(777 + index)).toString()
                return pet.guid
            })
        })
        assert.ok(ids.every((id) => BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)))
        const started = start(f, 1001, ids)
        assert.deepEqual(
            ledger(f).runs[1001].pet_experience.map((r) => r.gain),
            [110000, 0],
        )
        const startedPets = f.decode(started, 'PetInfoSync').pet_infos.pets
        assert.ok(
            ids.every((id) => startedPets.find((p) => p.guid === id)?.tour_state === 1),
            'wire pet mirror reserves exact uint64 IDs',
        )
        const before = f.state(),
            xpBefore = ids.map((id) => totalXp(before.pets.find((p) => p.guid === id))),
            balance14 = before.player.attr_infos.attrs.find((r) => r.attr_id === 14)
        f.advance(10)
        const packets = claim(f),
            reply = f.decode(packets, 'KiboTourReward')
        assert.deepEqual(
            reply.rewards.map((r) => [r.itemtype, r.itemid, r.itemnum]),
            [
                [3, 502000, 1],
                [10, 2, 1000],
            ],
        )
        assert.equal(reply.src, undefined, 'unconfirmed source is omitted instead of blocking delivery')
        const state = f.state()
        assert.equal(itemCount(state), itemCount(before) + 1)
        assert.equal(state.player.basic_info.gold, before.player.basic_info.gold + 1000)
        assert.ok(
            ids.every(
                (id) => f.decode(packets, 'PetInfoSync').pet_infos.pets.find((p) => p.guid === id)?.tour_state === 0,
            ),
        )
        assert.deepEqual(
            ids.map((id) => totalXp(state.pets.find((p) => p.guid === id))),
            [xpBefore[0] + 110000, xpBefore[1]],
        )
        assert.deepEqual(
            state.player.attr_infos.attrs.find((r) => r.attr_id === 14),
            balance14,
        )
        assert.equal(ledger(f).total_times, 1)
        assert.deepEqual(ledger(f).runs, {})
        assert.equal(ledger(f).receipts[1].status, 'claimed')
        assert.equal(ledger(f).receipts[1].experience[0].requested_gain, 110000)
        const ack = packets.findIndex((p) => p.id === 10408)
        for (const name of ['CSProtoPetInfoSync', 'CSProtoSyncPlayerData', 'CSProtoActivitySync'])
            assert.ok(packets.findIndex((p) => p.id === f.protocol.byName.get(name).id) < ack)
        const wire = f.decode(packets, 'ActivitySync').activitys.find((r) => r.id === 8001).data.tour_group
        assert.equal(wire.total_times, 1)
        assert.deepEqual(wire.tour_data, [])
        const saved = structuredClone(f.state())
        assert.deepEqual(f.decode(claim(f), 'KiboTourReward').rewards, [])
        assert.equal(itemCount(f.state()), itemCount(saved))
        assert.deepEqual(ledger(f), activityLedger(saved))
    } finally {
        f.close()
    }
})
function activityLedger(state) {
    return state.activities[8001].kiboTour
}
test('reward validates the actual completion second, rejects cancellation receipts, and a new trip cannot reuse the prior success', () => {
    const f = tourFixture('tour-reward-boundary')
    try {
        start(f)
        f.advance(9)
        const before = f.state()
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.ActivityTourStateCannotReward,
        )
        assert.deepEqual(f.state(), before)
        f.advance(1)
        claim(f)
        start(f)
        assert.equal(ledger(f).runs[1001].attempt_id, 2)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.ActivityTourStateCannotReward,
        )
        f.call('KiboTourCancel', { activity_id: 8001, tour_id: 1001 })
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.ActivityTourNotExist,
        )
        assert.equal(ledger(f).total_times, 1)
    } finally {
        f.close()
    }
})
test('past-window reward remains reachable, frees reservations and restores the original displayed time without reopening admission', () => {
    const f = tourFixture('tour-reward-expired')
    try {
        f.hardEnd = f.now + 1
        const id = f.petIds()[0]
        start(f, 1001, [id])
        f.advance(10)
        const packets = claim(f)
        assert.equal(ledger(f).total_times, 1)
        assert.equal(f.state().pets.find((p) => p.guid === id).tour_state, 0)
        assert.equal(f.snapshot().confs.find((r) => r.activity_id === 8001).end_time, f.hardEnd)
        assert.ok(!f.snapshot().activitys.some((r) => r.id === 8001))
        assert.equal(
            Number(f.decode(packets, 'SyncCommonTimeConf').data_list.find((r) => r.time_id === 998006).end_time),
            f.hardEnd,
        )
        assert.throws(
            () => start(f),
            (e) => e.code === ErrorCode.ActivityTimeLimit,
        )
    } finally {
        f.close()
    }
})
test('a corrupted missing or changed pet retains the trip and all rewards rather than silently skipping individual XP', () => {
    const f = tourFixture('tour-reward-corrupt-pet')
    try {
        const id = f.petIds()[0]
        start(f, 1001, [id])
        f.advance(10)
        const original = f.state().pets.find((p) => p.guid === id)
        f.edit((s) => (s.pets = s.pets.filter((p) => p.guid !== id)))
        let before = f.state()
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.PetNotExist && /trip retained/.test(e.message),
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => s.pets.push({ ...original, config_id: original.config_id + 1 }))
        before = f.state()
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.ActivityTourPetsDataError,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => (s.pets.find((p) => p.guid === id).config_id = original.config_id))
        claim(f)
        assert.equal(ledger(f).total_times, 1)
    } finally {
        f.close()
    }
})
test('level-capped pets do not block item delivery or consume a global experience balance', () => {
    const f = tourFixture('tour-reward-cap')
    try {
        const id = matchingPair(f)[0],
            cap = maximumLevel(tables.get('pet_level'), f.state().player.basic_info.lv)
        f.edit((s) =>
            Object.assign(
                s.pets.find((p) => p.guid === id),
                { lv: cap, exp: 123 },
            ),
        )
        start(f, 1001, [id])
        f.advance(10)
        claim(f)
        const pet = f.state().pets.find((p) => p.guid === id)
        assert.equal(pet.lv, cap)
        assert.equal(pet.exp, 123)
        assert.equal(ledger(f).total_times, 1)
    } finally {
        f.close()
    }
})
test('twenty-one genuine completed attempts reach the configured limit exactly without double-counting wire history', () => {
    const f = tourFixture('tour-reward-quota', { duration: 1 })
    try {
        for (let n = 1; n <= 21; n++) {
            start(f)
            f.advance(1)
            const packets = claim(f)
            assert.equal(ledger(f).total_times, n)
            const wire = f.decode(packets, 'ActivitySync').activitys.find((r) => r.id === 8001).data.tour_group
            assert.equal(wire.total_times + wire.tour_data.length, n)
        }
        const before = f.state()
        assert.throws(
            () => start(f),
            (e) => e.code === ErrorCode.ActivityTotalTourLimit,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(Object.keys(ledger(f).receipts).length, 21)
    } finally {
        f.close()
    }
})
test('reward response encoding failure atomically rolls back items, pet levels, total counter, mirrors and permanent receipts', () => {
    const f = tourFixture('tour-reward-codec')
    try {
        start(f, 1001, matchingPair(f))
        f.advance(10)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            type = f.protocol.byName.get('CSProtoKiboTourReward').rsp
        f.protocol.encode = (t, v) => {
            if (t === type) throw Error('tour reward codec')
            return encode(t, v)
        }
        assert.throws(() => claim(f), /tour reward codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        claim(f)
        assert.equal(ledger(f).total_times, 1)
    } finally {
        f.close()
    }
})
test('completed claim and per-pet XP survive actual temporary SQLite close/reopen and replay never duplicates rewards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-reward-')),
        file = path.join(dir, 'state.sqlite'),
        f = tourFixture('tour-reward-reopen', { file })
    try {
        const ids = matchingPair(f)
        start(f, 1001, ids)
        f.advance(10)
        claim(f)
        const before = f.state(),
            saved = ledger(f)
        f.reopen()
        assert.deepEqual(ledger(f), saved)
        assert.deepEqual(
            ids.map((id) => f.state().pets.find((p) => p.guid === id)),
            ids.map((id) => before.pets.find((p) => p.guid === id)),
        )
        assert.deepEqual(f.decode(claim(f), 'KiboTourReward').rewards, [])
        assert.equal(itemCount(f.state()), itemCount(before))
        assert.equal(ledger(f).total_times, 1)
    } finally {
        f.close()
        fs.rmSync(file, { force: true })
        fs.rmdirSync(dir)
    }
})
test('damaged run-key identity is also rejected by Reward without granting items, experience or a false receipt', () => {
    const f = tourFixture('tour-reward-key-integrity')
    try {
        start(f)
        f.advance(10)
        f.edit((s) => (s.activities[8001].kiboTour.runs[1001].tour_id = 1002))
        const before = f.state()
        assert.throws(
            () => f.call('ActivityGet'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(ledger(f).receipts, {})
    } finally {
        f.close()
    }
})
