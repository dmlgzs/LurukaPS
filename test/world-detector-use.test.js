import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, tables, count } from './world-detectors-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
const use = (f, data = {}) => f.call('UseItem', { itemid: f.itemId, num: 1, ...data })
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('6030 current detector items use the shared filters and return Rewards while syncing only real inventory consumption', () => {
    for (const item of tables.get('common_item').filter((r) => r.useType === 18)) {
        const f = fixture(item.id)
        try {
            if (!f.usable.length) {
                unchanged(f, () => use(f), ErrorCode.ParamError)
                continue
            }
            const before = f.state(),
                out = use(f),
                response = out.find((p) => p.id === 6030).data
            assert.deepEqual(response.rewards, [])
            assert.equal(response.obj_id, undefined)
            assert.equal(count(f.state(), item.id), count(before, item.id) - 1)
            assertSyncBefore(f.p, out, 'CSProtoSyncPlayerData', 6030)
            assert.deepEqual(f.state().worldObjects, before.worldObjects)
            assert.equal(f.state().player.basic_info.diamond, before.player.basic_info.diamond)
        } finally {
            f.close()
        }
    }
})

test('local use and server fallback share stock and a stale local target cannot charge when no valid target remains', () => {
    const f = fixture()
    try {
        assert(f.search().find((p) => p.id === 11075).data.obj_id > 0)
        use(f)
        assert.equal(count(f.state(), f.itemId), 1)
        f.edit((s) => {
            for (const row of f.usable.slice(0, 2)) s.worldObjects[f.map + ':' + row.id].complete = true
        })
        assert.equal(f.search().find((p) => p.id === 11075).data.obj_id, 0)
        assert.equal(count(f.state(), f.itemId), 1)
        unchanged(f, () => use(f), ErrorCode.ParamError)
    } finally {
        f.close()
    }
})

test('tool quantity, arguments, map binding and stock errors are validated before charging', () => {
    const f = fixture()
    try {
        unchanged(f, () => use(f, { num: 0 }), ErrorCode.ParamError)
        unchanged(f, () => use(f, { num: 2 }), ErrorCode.ParamError)
        unchanged(f, () => use(f, { args: [0] }), ErrorCode.ParamError)
        unchanged(f, () => use(f, { itemid: 1800008 }), ErrorCode.UseItemLimitInMap)
        f.edit((s) => {
            for (const i of s.player.sbag_infos.items) i.deadtime = 1799999999
        })
        unchanged(f, () => use(f), ErrorCode.ItemNotEnough)
    } finally {
        f.close()
    }
})

test('local detector ACK and pre-ACK inventory failures roll back the exact same shared transaction', () => {
    for (const name of ['CSProtoUseItem', 'CSProtoSyncPlayerData']) {
        const f = fixture()
        try {
            const before = f.state(),
                encode = f.p.encode.bind(f.p),
                type = f.p.byName.get(name).rsp
            f.p.encode = (n, v) => {
                if (n === type) throw Error('local detector codec failure')
                return encode(n, v)
            }
            assert.throws(() => use(f), /local detector codec failure/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
            use(f)
            assert.equal(count(f.state(), f.itemId), 2)
        } finally {
            f.close()
        }
    }
})
