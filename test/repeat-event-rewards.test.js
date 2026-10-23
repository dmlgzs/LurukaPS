import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
const count = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
const value = (s, id) => BigInt(s.player.attr_infos.attrs.find((x) => x.attr_id === id)?.attr_val ?? '0')
const mode = (f) => f.state().repeatEvent.levels['10001:10101'].mode_save_data[0]
function fixture(name, file) {
    const f = repeatFixture(name, file)
    f.store.transact(f.session.id, 0, (s) => {
        s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
    })
    return f
}
function clear(f, restart = false, requested = request) {
    f.call(restart ? 'RepeatEventReEnterLevelReq' : 'RepeatEventEnterLevelReq', requested)
    f.call('MultiCampaignPlayerLoadFinish')
    const stages = getEntrustCatalog(f.tables).stages(f.state().entrust.run.dungeon_id)
    f.interact(stages[0].row.id)
    for (const stage of stages.slice(1, -1)) f.kill(stage.row.id)
    assert(f.state().entrust.run.battle_complete)
}
test('real victory leaves combat inventory untouched; 9507 awards the exact first pool once and10508 before its ACK', () => {
    const f = fixture('repeat-first')
    try {
        const before = count(f.state(), 1600031)
        clear(f)
        assert.equal(count(f.state(), 1600031), before)
        const packets = f.call('EndDungeonScene', { result: 3 }),
            ack = packets.findIndex((x) => x.id === 9507)
        const first = packets.findIndex((x) => x.id === 10508)
        assert(first >= 0 && first < ack)
        assert.equal(count(f.state(), 1600031), before + 1)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].public_data.frist_pass_reward_fetched, true)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(count(f.state(), 1600031), before + 1)
        assert.equal(mode(f).win_count, 1)
    } finally {
        f.store.close()
    }
})
test('first box is free once; replayed box is empty and subsequent three-share box charges90 with three independent base/bonus rolls', () => {
    const f = fixture('repeat-box')
    try {
        const before = value(f.state(), 10011),
            first = count(f.state(), 1600031),
            experience = f.state().player.basic_info.exp
        clear(f)
        let packets = f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        let response = f.protocol.decode(f.protocol.byId.get(9974).rsp, packets.find((x) => x.id === 9974).payload)
        assert.equal(response.reward.rewards.find((x) => x.itemtype === 10 && x.itemid === 10011).itemnum, 15)
        assert.equal(response.extra_reward.rewards.find((x) => x.itemid === 10011).itemnum, 45)
        assert.equal(value(f.state(), 3), 500n)
        assert.equal(value(f.state(), 10011), before + 60n)
        assert.equal(count(f.state(), 1600031), first + 1)
        assert.equal(mode(f).free_stamina_used, true)
        assert.equal(mode(f).bonus_reward_daily_count, 1)
        packets = f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        response = f.protocol.decode(f.protocol.byId.get(9974).rsp, packets.find((x) => x.id === 9974).payload)
        assert.equal(response.reward.rewards.length, 0)
        assert.equal(response.extra_reward.rewards.length, 0)
        clear(f, true)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 3 })
        assert.equal(value(f.state(), 3), 410n)
        assert.equal(value(f.state(), 10011), before + 240n)
        assert.equal(f.state().player.basic_info.exp, experience + 200)
        assert.equal(mode(f).bonus_reward_daily_count, 4)
        assert.equal(f.state().repeatEvent.events[10001].total_cost_stamina, 90)
        assert.equal(count(f.state(), 1600031), first + 1)
        assert.deepEqual(f.state().entrust.records, {})
    } finally {
        f.store.close()
    }
})
test('configured eight daily bonus shares cap without blocking base rewards and reset at the existing activity day boundary', () => {
    const f = fixture('repeat-daily')
    try {
        clear(f)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        for (let i = 0; i < 3; i++) {
            clear(f, true)
            f.call('StaminaBoxGet', { box_id: 3001001, times: 3 })
        }
        assert.equal(mode(f).bonus_reward_daily_count, 8)
        const before = value(f.state(), 10011)
        clear(f, true)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        assert.equal(value(f.state(), 10011), before + 15n)
        f.tick(86400)
        clear(f, true)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 2 })
        assert.equal(mode(f).bonus_reward_daily_count, 2)
    } finally {
        f.store.close()
    }
})
test('first-pass and chest encoding failure roll back paid costs, random inventory rewards and every receipt', () => {
    const f = fixture('repeat-box-rollback')
    try {
        clear(f)
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(10508).rsp) throw Error('first pass wire')
            return encode(type, data)
        }
        assert.throws(() => f.call('StaminaBoxGet', { box_id: 3001001, times: 1 }), /first pass wire/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        clear(f, true)
        const paidBefore = structuredClone(f.state())
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9974).rsp) throw Error('chest wire')
            return encode(type, data)
        }
        assert.throws(() => f.call('StaminaBoxGet', { box_id: 3001001, times: 3 }), /chest wire/)
        assert.deepEqual(f.state(), paidBefore)
        f.protocol.encode = encode
        f.call('StaminaBoxGet', { box_id: 3001001, times: 3 })
        assert.equal(value(f.state(), 3), 410n)
    } finally {
        f.store.close()
    }
})
test('unearned box, invalid multiplier and insufficient paid stamina cannot mark any reward claimed', () => {
    const f = fixture('repeat-box-invalid')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: 3001001, times: 1 }),
            (e) => e.code === ErrorCode.RepeatEventLevelRewardNoUsabled,
        )
        f.call('CampaignQuit')
        clear(f)
        let before = structuredClone(f.state())
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: 3001001, times: 4 }),
            (e) => e.code === ErrorCode.StaminaBoxTimesInvalid,
        )
        assert.deepEqual(f.state(), before)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        clear(f, true)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '0'
        })
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: 3001001, times: 1 }),
            (e) => e.code === ErrorCode.StaminaNotEnough,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('all reward/free/bonus receipts survive complete SQLite restart, and fresh reentry never reopens historical box', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-repeat-box-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('repeat-box-sqlite', file)
    try {
        clear(f)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        const first = count(f.state(), 1600031),
            currency = value(f.state(), 10011)
        f.store.close()
        f = fixture('repeat-box-sqlite', file)
        assert.equal(mode(f).free_stamina_used, true)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        assert.equal(count(f.state(), 1600031), first)
        assert.equal(value(f.state(), 10011), currency)
        clear(f, true)
        assert.equal(f.state().entrust.run.chest_claimed, undefined)
        assert.equal(f.state().entrust.run.stage_index, 4)
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})

test('every configured repeat level completes its actual roster, grants its table-linked box and unlocks the next level', () => {
    const f = fixture('repeat-all-twelve')
    try {
        for (let level = 10101; level <= 10112; level++) {
            clear(f, false, { ...request, level })
            const run = f.state().entrust.run,
                chest = getEntrustCatalog(f.tables).chest(run.entrust_id)
            f.call('StaminaBoxGet', { box_id: chest.id, times: 1 })
            assert.equal(f.state().repeatEvent.levels['10001:' + level].public_data.frist_pass_reward_fetched, true)
            assert.equal(f.state().repeatEvent.levels['10001:' + level].mode_save_data[0].free_stamina_used, true)
            assert.equal(f.state().entrust.run.chest_claimed, true)
            f.call('CampaignQuit')
        }
        assert.equal(Object.keys(f.state().repeatEvent.levels).length, 12)
        assert.deepEqual(f.state().entrust.records, {})
        assert.equal(value(f.state(), 3), 500n)
    } finally {
        f.store.close()
    }
})
test('documented local combined-first-share policy charges only the nonfree shares and never grants three free entitlements', () => {
    const f = fixture('repeat-free-combined')
    try {
        clear(f)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 3 })
        assert.equal(value(f.state(), 3), 440n)
        assert.equal(mode(f).free_stamina_used, true)
        assert.equal(mode(f).bonus_reward_daily_count, 3)
        assert.equal(f.state().repeatEvent.events[10001].total_cost_stamina, 60)
    } finally {
        f.store.close()
    }
})
