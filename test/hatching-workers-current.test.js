import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-hatching-workers-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ setupHatchWorker, luaHatchDuration }, { ErrorCode }] = await Promise.all([
    import('./hatching-workers-current-fixture.js'),
    import('../src/error-codes.js'),
])

test('current worker fixture really selects trusted Sandbox under the normal-default Game factory', () => {
    const f = setupHatchWorker('hatch-worker-current-profile-identity')
    try {
        assert.deepEqual(f.state().starterProfile, { schemaVersion: 1, mode: 'sandbox', clientVersion: '1.0.0' })
        assert.equal(f.state().starterProfile.mode, 'sandbox')
    } finally {
        f.close()
    }
})

test('current BuildLocate,6532 worker and6574/6576 cards hatch ordinary20004001 using Lua duration and actual6111 reward', () => {
    const f = setupHatchWorker('hatch-worker-current-claim')
    try {
        const build = f.build()
        assert(Number.isSafeInteger(build.guid) && build.guid > 0)
        assert.equal(build.build_id, 30231)
        assert(f.located.some((packet) => packet.id === 6105))
        const stationed = f.station()
        assert(
            stationed.some(
                (packet) =>
                    packet.id === 6102 &&
                    packet.data.home_builds.some((row) => row.guid === build.guid && row.station_pet_guid === f.worker),
            ),
        )
        assert.equal(f.state().pets.find((row) => row.guid === f.worker).capacity_id, 5001)
        const expected = luaHatchDuration(f),
            card = f.amount(1000001),
            packets = f.start(),
            job = f.jobs()[0]
        assert.equal(job.seconds, expected.seconds)
        assert(job.seconds < expected.base)
        assert.equal(f.amount(1000001), card - 1)
        assert(packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 6506))
        assert.equal(f.state().pets.find((row) => row.guid === f.worker).work_status, 2)
        const selected = f.state().eggOutcomes[f.eggIds[0]],
            claim = { guid: build.guid, product_guids: [job.guid] }
        f.advance(job.seconds - 1)
        assert.throws(
            () => f.call('ProductFinish', claim),
            (error) =>
                error.code === ErrorCode.InvalidArgument && /No finished production available/.test(error.message),
        )
        f.advance(1)
        const before = f.state().pets.length,
            response = f.call('ProductFinish', claim).find((packet) => packet.id === 6111).data
        const reward = response.reward.rewards.find((row) => row.itemtype === 5)
        assert(reward)
        assert.equal(f.state().pets.length, before + 1)
        assert.equal(f.state().pets.find((row) => row.guid === reward.guid).config_id, selected)
        assert.equal(f.state().pets.find((row) => row.guid === f.worker).work_status, 1)
        assert.equal(f.jobs().length, 0)
        assert.deepEqual(
            f.call('ProductFinish', claim).find((packet) => packet.id === 6111).data.reward.rewards ?? [],
            [],
        )
        assert.equal(f.state().pets.length, before + 1)
        fs.writeFileSync(
            path.join(artifacts, 'duration.json'),
            JSON.stringify({ buildGuid: build.guid, worker: f.worker, expected, selected, pet: reward.guid }, null, 2),
        )
    } finally {
        f.close()
    }
})

test('current helper replacement preserves elapsed work and queue; cancellation retains selected species', () => {
    const f = setupHatchWorker('hatch-worker-current-retime')
    try {
        f.start()
        f.start(f.eggIds[1])
        const original = f.jobs()[0],
            selected = f.state().eggOutcomes[f.eggIds[0]]
        f.advance(Math.floor(original.seconds / 2))
        f.station()
        const shortened = f.jobs()[0]
        assert.equal(shortened.seconds, luaHatchDuration(f).seconds)
        assert(Math.abs((f.now() - shortened.start) / shortened.seconds - 0.5) < 0.001)
        assert.equal(f.jobs()[1].start, shortened.start + shortened.seconds)
        f.station('0')
        const restored = f.jobs()[0]
        assert.equal(restored.seconds, 18000)
        assert(Math.abs((f.now() - restored.start) / restored.seconds - 0.5) < 0.001)
        f.call('ProductCancel', { guid: f.build().guid, product_guids: [restored.guid] })
        assert.equal(f.state().eggOutcomes[f.eggIds[0]], selected)
        f.start(f.eggIds[0])
        assert.equal(f.state().eggOutcomes[f.eggIds[0]], selected)
    } finally {
        f.close()
    }
})

test('current fatigue changes labor component without inventing old fire-egg fixed seconds', () => {
    const f = setupHatchWorker('hatch-worker-current-fatigue')
    try {
        f.station()
        const fed = luaHatchDuration(f)
        f.store.transact(f.session.id, 0, (state) => {
            state.pets.find((p) => p.guid === f.worker).satiety_val = 9
        })
        const tired = luaHatchDuration(f)
        assert(tired.seconds > fed.seconds)
        assert.equal(tired.fixed, fed.fixed)
        f.start()
        assert.equal(f.jobs()[0].seconds, tired.seconds)
    } finally {
        f.close()
    }
})

test('actual6506 ACK encoding failure rolls back card,worker,egg,queue and sampled outcome', () => {
    const f = setupHatchWorker('hatch-worker-current-codec')
    try {
        f.station()
        const request = f.frame('HatchPetEgg', { build_guid: f.build().guid, egg_guid: f.eggIds[0] }),
            before = f.raw(),
            encode = f.protocol.encode,
            target = f.protocol.byId.get(6506).rsp
        let calls = 0
        f.protocol.encode = function (type, data) {
            if (type === target) {
                calls++
                throw Error('current-hatch-worker-codec')
            }
            return encode.call(this, type, data)
        }
        try {
            assert.throws(() => f.dispatch(request), /current-hatch-worker-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(calls, 1)
        assert.deepEqual(f.raw(), before)
        f.dispatch(request)
        assert.equal(f.jobs().length, 1)
    } finally {
        f.close()
    }
})

test('current Lua strict fatigue boundary accepts full efficiency at10 and11 while9 is tired', () => {
    const rows = []
    for (const satiety of [9, 10, 11]) {
        const f = setupHatchWorker('hatch-worker-current-boundary-' + satiety)
        try {
            assert.equal(Number(f.tables.get('game').find((row) => row.title === 'PET_HOME_TIRED_SATIETY').value), 10)
            f.station()
            f.store.transact(f.session.id, 0, (state) => {
                state.pets.find((p) => p.guid === f.worker).satiety_val = satiety
            })
            const expected = luaHatchDuration(f)
            f.start()
            rows.push({ satiety, expected: expected.seconds, actual: f.jobs()[0].seconds, reference: expected })
        } finally {
            f.close()
        }
    }
    fs.writeFileSync(path.join(artifacts, 'fatigue-boundary.json'), JSON.stringify(rows, null, 2))
    assert.deepEqual(
        rows.map((row) => row.actual),
        rows.map((row) => row.expected),
    )
    assert(rows[0].actual > rows[1].actual)
    assert.equal(rows[1].actual, rows[2].actual)
})

test('old6507 is not current Lua6111 and guaranteed40003007 remains explicit pending before card debit', () => {
    const f = setupHatchWorker('hatch-worker-current-pending')
    try {
        assert.equal(f.protocol.byId.has(6507), false)
        const before = f.raw()
        assert.throws(
            () => f.game.dispatch(f.session, { id: 6507, seq: 900, payload: Buffer.alloc(0) }),
            (error) => error.code === ErrorCode.InvalidProtoID,
        )
        assert.deepEqual(f.raw(), before)
        f.grant([{ itemtype: 14, itemid: 40003007, itemnum: 1 }])
        const egg = f.state().petEggs.find((row) => row.configid === 40003007),
            pending = f.raw(),
            card = f.amount(1000001)
        assert.throws(
            () => f.start(egg.guid),
            (error) => error.code === ErrorCode.FunctionClosed && /Guaranteed hatch rules/.test(error.message),
        )
        assert.deepEqual(f.raw(), pending)
        assert.equal(f.amount(1000001), card)
    } finally {
        f.close()
    }
})
