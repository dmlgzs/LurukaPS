import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'
const goals = (f) => journeyModel(f.tables).targets.filter((row) => row.tokens[0] === 12062)
function unlockOnlyOtherPrerequisites(f) {
    const model = journeyModel(f.tables)
    f.edit((s) => {
        const visited = new Set()
        const rules = (list) => {
            for (const [kind, id] of list) {
                if (kind === 2004) s.player.basic_info.lv = Math.max(s.player.basic_info.lv, id)
                else if (kind === 12098) s.journey.tasks[id] = { claimed: true, complete: true }
                else if (kind === 12096) {
                    visit(id)
                    for (const targetId of model.byTask.get(id).ids) {
                        const target = model.byTarget.get(targetId)
                        if (target.tokens[0] === 12062)
                            assert(s.journey.targets[targetId]?.complete, 'never inject a new farm goal')
                        else s.journey.targets[targetId] = { value: target.targetParam, complete: true, claimed: false }
                    }
                } else throw Error('Unimplemented isolated prerequisite fixture kind:' + kind)
            }
        }
        const visit = (id) => {
            if (visited.has(id)) return
            visited.add(id)
            const task = model.byTask.get(id)
            rules(model.tabById.get(task.tabId).unlockRules)
            rules(task.unlockRules)
        }
        for (const row of goals(f)) visit(model.owner.get(row.id))
    })
    // Level prerequisite reconciliation is existing Game behavior. This does
    // not create any farm fact or complete either new target.
    f.call('ActivityGet')
    f.call('ActivityGet')
}

test('complete12062 two-target family observes actual manual harvest and actual assigned-worker storage acquisition separately', () => {
    const f = farmHarvestFixture('farm-journey-real')
    try {
        const rows = goals(f)
        assert.equal(rows.length, 2)
        assert(rows.every((row) => row.supported && journeyModel(f.tables).owner.has(row.id)))
        f.grow(31)
        assert(f.harvest().some((row) => row.id === 11880))
        assert.equal(f.state().journey.targets[2030004].complete, true)
        f.assign()
        f.grow(32)
        f.harvest(100, true)
        assert.equal(f.state().journey.targets[2030017].complete, false)
        assert(f.call('GetAutoWorkCropReward', { u32: 20 }).some((row) => row.id === 11880))
        assert(rows.every((row) => f.state().journey.targets[row.id].complete))
        assert(rows.every((row) => journeyValue(f.tables, f.state(), row) === 1))
    } finally {
        f.close()
    }
})

test('11880 failures roll back actual manual harvest and worker pending claims with their typed source facts', () => {
    const f = farmHarvestFixture('farm-journey-atomic')
    try {
        for (const worker of [false, true]) {
            if (worker) f.assign()
            f.grow(worker ? 32 : 31)
            if (worker) f.harvest(100, true)
            const before = f.state(),
                encode = f.protocol.encode
            let visited = false
            f.protocol.encode = function (name, payload) {
                if (name === f.protocol.byId.get(11880).rsp) {
                    visited = true
                    throw Error('farm-journey-sync')
                }
                return encode.call(this, name, payload)
            }
            assert.throws(
                () => (worker ? f.call('GetAutoWorkCropReward', { u32: 20 }) : f.harvest()),
                /farm-journey-sync/,
            )
            assert(visited)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            if (worker) f.call('GetAutoWorkCropReward', { u32: 20 })
            else f.harvest()
        }
        assert(goals(f).every((row) => f.state().journey.targets[row.id].complete))
    } finally {
        f.close()
    }
})

test('actual farm goals retain chapter gates; isolated unrelated prerequisites validate9869 rollback,idempotency and SQLite account separation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-harvest-journey-')),
        file = path.join(dir, 'farm.sqlite')
    let f
    try {
        f = farmHarvestFixture('farm-journey-persist', file)
        f.grow(31)
        f.harvest()
        f.assign()
        f.grow(32)
        f.harvest(100, true)
        f.call('GetAutoWorkCropReward', { u32: 20 })
        const beforeLock = f.state()
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [30004] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        assert.deepEqual(f.state(), beforeLock)
        // Only unrelated prerequisite receipts/levels are supplied. Both new
        // farm targets above are already complete from actual public actions.
        unlockOnlyOtherPrerequisites(f)
        const ready = f.state(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(9869).rsp) throw Error('farm-journey-reward')
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: [30004, 30017] }), /farm-journey-reward/)
        assert.deepEqual(f.state(), ready)
        f.protocol.encode = encode
        f.call('JourneyTaskFinish', { u32s: [30004, 30017] })
        const saved = f.state().home.farmHarvestProgress,
            now = f.now()
        for (const row of goals(f)) assert.equal(f.state().journey.targets[row.id].claimed, true)
        const once = f.state(),
            reply = f.call('JourneyTaskFinish', { u32s: [30004, 30017] }).find((row) => row.id === 9869)
        assert.deepEqual(f.protocol.decode('Rewards', reply.payload).rewards, [])
        assert.deepEqual(f.state().player, once.player)
        f.close()
        f = undefined
        f = farmHarvestFixture('farm-journey-persist', file, { resume: true, now })
        assert.deepEqual(f.state().home.farmHarvestProgress, saved)
        assert(goals(f).every((row) => f.state().journey.targets[row.id].claimed))
        const other = farmHarvestFixture('farm-journey-other', file, { now })
        try {
            assert(goals(other).every((row) => journeyValue(other.tables, other.state(), row) === 0))
        } finally {
            other.close()
        }
    } finally {
        f?.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('farm-harvest-journey-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
