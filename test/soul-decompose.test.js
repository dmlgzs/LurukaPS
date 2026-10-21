import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { soulDecomposePlan } from '../src/soul-decompose.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
        return { packets, result: protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload) }
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    return { protocol, store, session, call, state }
}
test('all current 54 decomposable templates match previews; 21 rarity-four templates are ineligible even with configured rewards', () => {
    const s = seedPlayer(tables, 1, 'decompose-catalog')
    let eligible = 0,
        excluded = 0
    for (const item of s.player.soulessence_infos.soulessences) {
        item.lock = false
        const config = tables.find('soulessence', item.id)
        if (config.rarity === 4) {
            excluded++
            assert.throws(
                () => soulDecomposePlan(tables, s, [item.guid]),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
        } else {
            eligible++
            assert.deepEqual(soulDecomposePlan(tables, s, [item.guid]).rewards, parseRewards(config.decomposed))
        }
    }
    assert.equal(eligible, 54)
    assert.equal(excluded, 21)
})
test('6051 aggregates table rewards, removes actual instances before ACK and never repeats after retry or relogin', () => {
    const f = fixture('decompose-batch')
    try {
        let guids
        f.store.transact(f.session.id, 0, (s) => {
            guids = grantRewards(tables, s, [
                { itemtype: 9, itemid: 10044, itemnum: 2 },
                { itemtype: 9, itemid: 10066, itemnum: 1 },
            ]).map((r) => Number(r.guid))
            for (const item of s.player.soulessence_infos.soulessences)
                if (guids.includes(item.guid)) {
                    item.lock = false
                    item.exp = 10
                }
        })
        const count = (id) =>
            f
                .state()
                .player.sbag_infos.items.filter((i) => i.itemid === id)
                .reduce((n, i) => n + i.itemnum, 0)
        const first = count(400002),
            second = count(400000),
            { packets, result } = f.call('DecomposeSoulEssence', { guids })
        assert.equal(result.src, 155)
        assert.deepEqual(
            result.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            [
                { itemtype: 3, itemid: 400002, itemnum: 2 },
                { itemtype: 3, itemid: 400000, itemnum: 2 },
            ],
        )
        assert.equal(count(400002), first + 2)
        assert.equal(count(400000), second + 2)
        assert(!f.state().player.soulessence_infos.soulessences.some((i) => guids.includes(i.guid)))
        const ack = packets.findIndex((p) => p.id === 6051),
            syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        const removed = packets
            .slice(0, ack)
            .filter((p) => p.id === syncId)
            .flatMap(
                (p) => f.protocol.decode(f.protocol.byId.get(syncId).rsp, p.payload).soulessence_infos?.del_pos ?? [],
            )
        assert(guids.every((id) => removed.includes(id)))
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('DecomposeSoulEssence', { guids }),
            (e) => e.code === ErrorCode.SoulEssenceNotExist,
        )
        assert.deepEqual(f.state(), saved)
        f.call('EnterGame', { open_id: 'decompose-batch' }, {})
        assert.equal(count(400002), first + 2)
        assert.equal(count(400000), second + 2)
        assert(!f.state().player.soulessence_infos.soulessences.some((i) => guids.includes(i.guid)))
    } finally {
        f.store.close()
    }
})
test('a bad reward after valid rewards rolls back the entire batch including removed instances and item GUID allocation', () => {
    const f = fixture('decompose-rollback'),
        config = tables.find('soulessence', 10066),
        original = config.decomposed
    try {
        f.call('SetLockSoulEssence', { guids: [10044, 10066], lock: false })
        config.decomposed = '3#400000#2|3#4294967295#1'
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('DecomposeSoulEssence', { guids: [10044, 10066] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        config.decomposed = original
        f.store.close()
    }
})
test('decompose validates the actual 500-entry table limit and rejects duplicate or unknown instances', () => {
    const s = seedPlayer(tables, 1, 'decompose-limit'),
        sample = s.player.soulessence_infos.soulessences.find((i) => i.id === 10066)
    const copies = Array.from({ length: 500 }, (_, index) => ({ ...sample, guid: 100000 + index, lock: false }))
    s.player.soulessence_infos.soulessences.push(...copies)
    const plan = soulDecomposePlan(
        tables,
        s,
        copies.map((i) => i.guid),
    )
    assert.equal(plan.selected.size, 500)
    assert.deepEqual(plan.rewards, [{ itemtype: 3, itemid: 400000, itemnum: 1000 }])
    assert.throws(
        () => soulDecomposePlan(tables, s, [...copies.map((i) => i.guid), 9999999]),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    assert.throws(
        () => soulDecomposePlan(tables, s, []),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    assert.throws(
        () => soulDecomposePlan(tables, s, [copies[0].guid, copies[0].guid]),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    assert.throws(
        () => soulDecomposePlan(tables, s, [9999999]),
        (e) => e.code === ErrorCode.SoulEssenceNotExist,
    )
})
test('locked, equipped, strengthened, refined and preview items are never silently destroyed', () => {
    const f = fixture('decompose-ineligible')
    try {
        for (const [patch, code] of [
            [{ lock: true }, ErrorCode.LockSoulEssence],
            [{ wear_hero: '123' }, ErrorCode.SoulEssenceOnWear],
            [{ lv: 2 }, ErrorCode.InvalidArgument],
            [{ advance: 2 }, ErrorCode.InvalidArgument],
            [{ zombie: true }, ErrorCode.InvalidArgument],
            [{ advance: -1 }, ErrorCode.GameConfig],
        ]) {
            f.store.transact(f.session.id, 0, (s) =>
                Object.assign(
                    s.player.soulessence_infos.soulessences.find((i) => i.guid === 10044),
                    { lock: false, wear_hero: '0', lv: 1, advance: 1, zombie: false },
                    patch,
                ),
            )
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('DecomposeSoulEssence', { guids: [10044] }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
