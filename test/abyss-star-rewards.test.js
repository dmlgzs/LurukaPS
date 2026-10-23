import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { parseRewards } from '../src/rewards.js'

function amount(s, item) {
    if (item.itemtype === 10) {
        if (item.itemid === 1) return s.player.basic_info.diamond
        if (item.itemid === 2) return s.player.basic_info.gold
        return Number(s.player.attr_infos.attrs.find((x) => x.attr_id === item.itemid)?.attr_val ?? 0)
    }
    return s.player.sbag_infos.items.filter((x) => x.itemid === item.itemid).reduce((n, x) => n + x.itemnum, 0)
}
function progress(f, levels) {
    f.store.transact(f.session.id, 0, (s) => {
        s.abyss ??= { modes: {} }
        s.abyss.modes[1] ??= { levels: {}, starClaims: [] }
        for (let i = 0; i < levels; i++) s.abyss.modes[1].levels[10001 + i] = { passed: true, star_num: 3 }
    })
}
test('11453 grants every reached unclaimed tier, returns cumulative receipts and supplies only the newly appended native reward suffix', () => {
    const f = abyssFixture('abyss-stars')
    try {
        assert.throws(
            () => f.call('AbyssGetStarReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssStarRewardAlready,
        )
        const initialized = f.decode(f.call('AbyssData'), 'CSProtoAbyssData').newer_star_reward_info.reward_list
        assert.deepEqual(initialized, [])
        progress(f, 1)
        const first = f.decode(f.call('AbyssGetStarReward', { mode: 1 }), 'CSProtoAbyssGetStarReward').reward_info
            .reward_list
        assert.deepEqual(first, [{ stage_num: 3, reward_flag: true }])
        progress(f, 3)
        const before = f.state(),
            result = f.decode(f.call('AbyssGetStarReward', { mode: 1 }), 'CSProtoAbyssGetStarReward')
        assert.deepEqual(
            result.reward_info.reward_list.map((x) => x.stage_num),
            [3, 6, 9],
        )
        assert.deepEqual(
            result.reward_info.reward_list.slice(first.length).map((x) => x.stage_num),
            [6, 9],
        )
        const plan = abyssTables(f.tables)
                .get('abbys_reward')
                .filter((x) => x.groupId === 10001 && [6, 9].includes(x.num))
                .flatMap((x) => parseRewards(x.reward)),
            totals = new Map()
        for (const item of plan) {
            const key = item.itemtype + ':' + item.itemid
            const total = totals.get(key) ?? { ...item, itemnum: 0 }
            total.itemnum += item.itemnum
            totals.set(key, total)
        }
        for (const item of totals.values()) assert.equal(amount(f.state(), item) - amount(before, item), item.itemnum)
        const claimed = f.state()
        assert.throws(
            () => f.call('AbyssGetStarReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssStarRewardAlready,
        )
        assert.deepEqual(f.state(), claimed)
        assert.deepEqual(
            f.decode(f.call('AbyssData'), 'CSProtoAbyssData').newer_star_reward_info.reward_list,
            result.reward_info.reward_list,
        )
    } finally {
        f.store.close()
    }
})
test('11453 never counts unpassed or foreign-rotation stars, and rolls back actual delivery plus all receipts if encoding fails', () => {
    const f = abyssFixture('abyss-star-codec')
    try {
        progress(f, 2)
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss.modes[1].levels[10003] = { passed: false, star_num: 3 }
            s.abyss.rotation = { id: 999, levels: { 30001: { passed: true, star_num: 3 } }, starClaims: [] }
        })
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssGetStarReward') throw Error('abyss stars codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssGetStarReward', { mode: 1 }), /abyss stars codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f
                .decode(f.call('AbyssGetStarReward', { mode: 1 }), 'CSProtoAbyssGetStarReward')
                .reward_info.reward_list.map((x) => x.stage_num),
            [3, 6],
        )
        assert.throws(
            () => f.call('AbyssGetStarReward', { mode: 3 }),
            (e) => e.code === ErrorCode.AbyssStarRewardAlready,
        )
    } finally {
        f.store.close()
    }
})
test('11453 SQLite reopen keeps star receipts and actual wallet without regranting a tier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-stars-')),
        file = path.join(dir, 'save.sqlite')
    let f
    try {
        f = abyssFixture('abyss-star-sql', file)
        progress(f, 2)
        f.call('AbyssGetStarReward', { mode: 1 })
        const before = f.state().player.basic_info.diamond
        f.store.close()
        f = abyssFixture('abyss-star-sql', file, true)
        assert.equal(f.state().player.basic_info.diamond, before)
        assert.deepEqual(f.state().abyss.modes[1].starClaims, [3, 6])
        assert.throws(
            () => f.call('AbyssGetStarReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssStarRewardAlready,
        )
    } finally {
        f?.store.close()
        if (
            path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
            path.basename(dir).startsWith('abyss-stars-')
        )
            fs.rmSync(dir, { recursive: true, force: true })
    }
})
