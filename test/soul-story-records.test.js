import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { recordSoulStory, soulStoryIds } from '../src/soul-story-records.js'
const conf = configuration(),
    tables = new Tables(conf.tables),
    protocol = new Protocol(conf.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'soul-story' })
    }
    login()
    return {
        store,
        call,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        saved: () => JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state),
    }
}
test('10804 records the equipment configuration ID on click, persists and returns it without completing the story or granting rewards', () => {
    const f = setup()
    try {
        const before = f.state(),
            packets = f.call('LiZiStoryRecored', { cfg_id: 10001 }),
            reply = packets.find((p) => p.id === 10804)
        assert.ok(reply)
        assert.deepEqual(protocol.decode('SCLiZiStoryRecored', reply.payload), { cfg_id: 10001 })
        const after = f.state()
        assert.deepEqual(after.soulEssenceStoryRecords, [10001])
        assert.deepEqual(after.storyWatches, before.storyWatches)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(after.player.soulessence_infos, before.player.soulessence_infos)
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold)
        assert.equal(
            packets.some((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id),
            false,
        )
        f.store.flushPending()
        assert.deepEqual(f.saved().soulEssenceStoryRecords, [10001])
        const login = f.login(),
            entry = protocol.byName.get('CSProtoEnterGame'),
            packet = login.find((p) => p.id === entry.id)
        assert.ok(packet)
        const data = protocol.decode(entry.rsp, packet.payload).data
        assert.deepEqual(data.soulessence_infos.cfg_story_id, [10001])
        assert.ok(!data.soulessence_infos.cfg_story_id.includes(700100))
    } finally {
        f.store.close()
    }
})
test('all 32 current story-bearing configurations have real stories and empty locks and can be recorded from owned equipment', () => {
    const f = setup()
    try {
        const rows = tables.get('soulessence').filter((row) => row.story > 0)
        assert.equal(rows.length, 32)
        for (const row of rows) {
            assert.equal(row.storyLock, '')
            assert.ok(tables.find('story', row.story))
            f.call('LiZiStoryRecored', { cfg_id: row.id })
        }
        assert.deepEqual(
            f.state().soulEssenceStoryRecords,
            rows.map((row) => row.id).sort((a, b) => a - b),
        )
        const once = f.state().soulEssenceStoryRecords
        f.call('LiZiStoryRecored', { cfg_id: 10001 })
        assert.deepEqual(f.state().soulEssenceStoryRecords, once)
    } finally {
        f.store.close()
    }
})
test('invalid IDs, missing stories and unowned unread equipment do not change read records', () => {
    const f = setup()
    try {
        const empty = tables.get('soulessence').find((row) => !row.story)
        for (const [cfg_id, code] of [
            [0, ErrorCode.InvalidArgument],
            [4294967295, ErrorCode.SoulEssenceConfNotExist],
            [empty.id, ErrorCode.StoryConfNotExist],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('LiZiStoryRecored', { cfg_id }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.edit(
            (s) =>
                (s.player.soulessence_infos.soulessences = s.player.soulessence_infos.soulessences.filter(
                    (row) => row.id !== 10001,
                )),
        )
        const before = f.state()
        assert.throws(
            () => f.call('LiZiStoryRecored', { cfg_id: 10001 }),
            (e) => e.code === ErrorCode.SoulEssenceNotExist,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('read history survives equipment decomposition and repeated requests do not require a newly owned copy', () => {
    const f = setup()
    try {
        f.call('LiZiStoryRecored', { cfg_id: 10001 })
        f.edit(
            (s) =>
                (s.player.soulessence_infos.soulessences = s.player.soulessence_infos.soulessences.filter(
                    (row) => row.id !== 10001,
                )),
        )
        f.call('LiZiStoryRecored', { cfg_id: 10001 })
        assert.deepEqual(f.state().soulEssenceStoryRecords, [10001])
        f.login()
        assert.deepEqual(f.state().soulEssenceStoryRecords, [10001])
    } finally {
        f.store.close()
    }
})
test('future nonempty story locks remain explicitly unsupported and legacy config IDs merge without duplication', () => {
    const f = setup()
    try {
        const state = f.state(),
            proxy = {
                find: (name, id) =>
                    name === 'soulessence'
                        ? { ...tables.find(name, id), storyLock: 'unknown-selector' }
                        : tables.find(name, id),
            }
        assert.throws(
            () => recordSoulStory({ state, tables: proxy }, { cfg_id: 10001 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        state.player.soulessence_infos.cfg_story_id = [10001, 10001]
        state.soulEssenceStoryRecords = [10008]
        assert.deepEqual(soulStoryIds(state), [10001, 10008])
    } finally {
        f.store.close()
    }
})
test('failed record ACK encoding rolls back the durable record', () => {
    const f = setup()
    try {
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoLiZiStoryRecored').rsp) throw Error('soul story ACK failed')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('LiZiStoryRecored', { cfg_id: 10001 }), /ACK failed/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
