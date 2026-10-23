import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { parseRewards } from '../src/rewards.js'
import { abyssTables } from '../src/abyss-catalog.js'

function win(f) {
    f.call('AbyssChallenge', f.request())
    f.call('AbyssChallengeRealStart')
    while (f.state().abyssRun.phase === 'running') {
        const s = f.state(),
            r = s.abyssRun
        for (const x of Object.values(s.combat.entities).filter(
            (x) => r.wave_objects.includes(x.object_id) && x.hp > 0,
        ))
            f.call('BattleInfoReduce', {
                uint64_dic: [r.challenges[0].control, x.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -x.hp } }],
            })
    }
}
function amount(s, id) {
    if (id === 2) return s.player.basic_info.gold
    if (id === 1) return s.player.basic_info.diamond
    const currency = s.player.attr_infos.attrs.find((x) => x.attr_id === id)
    if (currency) return Number(currency.attr_val)
    return s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
}
test('11452 uses genuine clear producer, grants actual table items and returns only newly claimed levels', () => {
    const f = abyssFixture('abyss-pass-reward')
    try {
        assert.throws(
            () => f.call('AbyssGetPassReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssPassedRewardAlready,
        )
        win(f)
        const before = f.state(),
            plan = parseRewards(abyssTables(f.tables).find('abbys_level', 10001).levelReward)
        const packets = f.call('AbyssGetPassReward', { mode: 1 }),
            reply = f.decode(packets, 'CSProtoAbyssGetPassReward')
        assert.deepEqual(
            reply.level_info.map((x) => x.cur_level),
            [10001],
        )
        assert(reply.level_info[0].pass_level_reward_flag)
        assert.equal(Object.hasOwn(reply, 'rewards'), false)
        for (const item of plan)
            assert.equal(amount(f.state(), item.itemid) - amount(before, item.itemid), item.itemnum)
        assert(packets.some((x) => x.id === f.p.byName.get('CSProtoSyncPlayerData').id))
        const claimed = f.state()
        assert.throws(
            () => f.call('AbyssGetPassReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssPassedRewardAlready,
        )
        assert.deepEqual(f.state(), claimed)
        assert.throws(
            () => f.call('AbyssGetPassReward', { mode: 0 }),
            (e) => e.code === ErrorCode.AbyssInvalidMode,
        )
    } finally {
        f.store.close()
    }
})
test('11452 batches all eligible first-clear rewards, preserving best records and rolling back grant plus receipts on codec failure', () => {
    const f = abyssFixture('abyss-pass-codec')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = {
                modes: {
                    1: {
                        levels: {
                            10001: { passed: true, star_num: 3 },
                            10002: { passed: true, star_num: 2 },
                            10003: { passed: false, star_num: 0 },
                        },
                    },
                },
            }
        })
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssGetPassReward') throw Error('abyss pass codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssGetPassReward', { mode: 1 }), /abyss pass codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        const result = f.decode(f.call('AbyssGetPassReward', { mode: 1 }), 'CSProtoAbyssGetPassReward')
        assert.deepEqual(
            result.level_info.map((x) => x.cur_level),
            [10001, 10002],
        )
        assert.deepEqual(
            result.level_info.map((x) => x.star_num),
            [3, 2],
        )
        assert(!f.state().abyss.modes[1].levels[10003].pass_level_reward_flag)
    } finally {
        f.store.close()
    }
})
test('11452 persists receipt and bag across SQLite reopen without accepting old-season progress as the current rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-pass-')),
        file = path.join(dir, 'save.sqlite')
    let f
    try {
        f = abyssFixture('abyss-pass-sql', file)
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = {
                modes: { 1: { levels: { 10001: { passed: true, star_num: 3 } } } },
                rotation: { id: 999, levels: { 30001: { passed: true, star_num: 3 } } },
            }
        })
        f.call('AbyssGetPassReward', { mode: 1 })
        const claimed = f.state(),
            amount417 = amount(claimed, 417)
        f.store.close()
        f = abyssFixture('abyss-pass-sql', file, true)
        assert.equal(amount(f.state(), 417), amount417)
        assert(f.state().abyss.modes[1].levels[10001].pass_level_reward_flag)
        assert.throws(
            () => f.call('AbyssGetPassReward', { mode: 1 }),
            (e) => e.code === ErrorCode.AbyssPassedRewardAlready,
        )
        assert.throws(
            () => f.call('AbyssGetPassReward', { mode: 3 }),
            (e) => e.code === ErrorCode.AbyssPassedRewardAlready,
        )
    } finally {
        f?.store.close()
        if (
            path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
            path.basename(dir).startsWith('abyss-pass-')
        )
            fs.rmSync(dir, { recursive: true, force: true })
    }
})
