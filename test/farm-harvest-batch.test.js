import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { farmHarvestProgressValue } from '../src/farm-harvest-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const value = (f, type) => farmHarvestProgressValue(f.tables, f.state(), [12005, type, 10000])

test('6119 actual default-manual batch credits every mature root and actual products while literal field classes remain distinct', () => {
    const f = farmHarvestFixture('farm-batch-real')
    try {
        f.grow(31, 100)
        f.grow(32, 101)
        const result = f.call('FieldHarvestList', { build_guids: [100, 101] }).find((r) => r.id === 6119)
        assert.equal(f.protocol.decode(f.protocol.byId.get(6119).rsp, result.payload).results.length, 2)
        assert.equal(value(f, 15), 4)
        assert.equal(value(f, 19), 4)
        assert.deepEqual(f.state().home.farmHarvestProgress.roots, { '15:31': 1, '19:32': 1 })
        const once = f.state()
        assert.throws(
            () => f.call('FieldHarvestList', { build_guids: [100, 101] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), once)
    } finally {
        f.close()
    }
})

test('6119 validation and ACK failure never leave a partial batch award,cleared crop or source count', () => {
    const f = farmHarvestFixture('farm-batch-atomic')
    try {
        f.grow(31, 100)
        f.grow(32, 101)
        const before = f.state()
        for (const [ids, code] of [
            [[100, 100], ErrorCode.InvalidArgument],
            [[100, 0xffffffff], ErrorCode.HomeFieldNotOpen],
        ]) {
            assert.throws(
                () => f.call('FieldHarvestList', { build_guids: ids }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        const encode = f.protocol.encode
        let visited = false
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(6119).rsp) {
                visited = true
                throw Error('farm-batch-encode')
            }
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.call('FieldHarvestList', { build_guids: [100, 101] }), /farm-batch-encode/)
        assert(visited)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('FieldHarvestList', { build_guids: [100, 101] })
        assert.equal(value(f, 15), 4)
        assert.equal(value(f, 19), 4)
    } finally {
        f.close()
    }
})
