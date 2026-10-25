import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { journeyModel, observeJourney, journeyValue } from '../src/journey.js'
import { workerAssignmentProgressRule, workerAssignmentProgressValue } from '../src/worker-assignment-progress.js'
import { ErrorCode } from '../src/error-codes.js'
import { productionTables } from '../src/production-tables.js'
const jobs = (f) => journeyModel(f.tables).byKind.get(12247),
    raw = (f, job) => workerAssignmentProgressValue(f.tables, f.state(), [12247, job, 10000]),
    station = (f, pet, type = 0) => f.call('PetStationInHomeHub', { pet_guid: pet.guid, type }),
    abilities = (p) => new Set((p.labor_infos ?? []).filter((r) => r.labor_grade > 0).map((r) => r.labor_id))
function cover(f) {
    const missing = new Set(jobs(f).map((row) => row.tokens[1])),
        out = []
    while (missing.size) {
        const pick = f
            .state()
            .pets.filter((p) => !p.work_status || p.work_status === 7)
            .map((p) => ({ p, score: [...abilities(p)].filter((id) => missing.has(id)) }))
            .sort((a, b) => b.score.length - a.score.length || a.p.config_id - b.p.config_id)[0]
        assert(pick?.score.length, 'Actual permanent seed pets must cover the full current labor family')
        out.push(pick.p)
        for (const id of pick.score) missing.delete(id)
    }
    return out
}
function unlockRewardTab(f) {
    f.edit((s) => {
        s.journey.tasks[20000] = { complete: true, claimed: true }
        s.journey.claimRevision++
    })
}
test('complete12247 nine-job current family excludes absent,temporary,wild,stale andzero-grade actors and canonical UID aliases never double-count', () => {
    const f = farmHarvestFixture('worker-current-contract')
    try {
        const rows = jobs(f),
            model = journeyModel(f.tables)
        assert.equal(rows.length, 9)
        assert(rows.every((row) => row.supported && journeyValue(f.tables, f.state(), row) === 0))
        assert.equal(model.targets.filter((row) => row.supported).length, 184)
        assert.equal(model.referencedTargets.filter((row) => row.supported).length, 168)
        assert(rows.every((row) => workerAssignmentProgressRule(f.tables, row.tokens)))
        for (const tokens of [
            [12247, 0, 1],
            [12247, 8, 1],
            [12247, 1, 0],
            [12247, 1, 1, 1],
        ])
            assert.equal(workerAssignmentProgressRule(f.tables, tokens), false)
        const pet = cover(f)[0],
            job = [...abilities(pet)][0]
        station(f, pet)
        assert.equal(raw(f, job), 1)
        const state = f.state(),
            before = structuredClone(state)
        state.home.stationPets.push('0' + pet.guid, pet.guid)
        assert.equal(workerAssignmentProgressValue(f.tables, state, [12247, job, 10000]), 1)
        for (const status of [0, 3, 4]) {
            const copy = structuredClone(before)
            copy.pets.find((p) => p.guid === pet.guid).work_status = status
            assert.equal(workerAssignmentProgressValue(f.tables, copy, [12247, job, 10000]), 0)
        }
        for (const status of [1, 2, 5, 6, 7]) {
            const copy = structuredClone(before)
            copy.pets.find((p) => p.guid === pet.guid).work_status = status
            assert.equal(
                workerAssignmentProgressValue(f.tables, copy, [12247, job, 10000]),
                1,
                'Current-home states do not imply selected-job filtering',
            )
        }
        for (const flag of ['trial', 'trail', 'is_trial', 'abyss']) {
            const copy = structuredClone(before)
            copy.pets.find((p) => p.guid === pet.guid)[flag] = true
            assert.equal(workerAssignmentProgressValue(f.tables, copy, [12247, job, 10000]), 0)
        }
        const temporary = structuredClone(before)
        temporary.trialGroup = { pets: [{ guid: pet.guid }] }
        assert.equal(workerAssignmentProgressValue(f.tables, temporary, [12247, job, 10000]), 0)
        const missing = structuredClone(before)
        missing.pets = missing.pets.filter((p) => p.guid !== pet.guid)
        assert.equal(workerAssignmentProgressValue(f.tables, missing, [12247, job, 10000]), 0)
        const noGrade = structuredClone(before)
        noGrade.pets.find((p) => p.guid === pet.guid).labor_infos.forEach((row) => (row.labor_grade = 0))
        assert.equal(workerAssignmentProgressValue(f.tables, noGrade, [12247, job, 10000]), 0)
        const hungry = structuredClone(before)
        hungry.pets.find((p) => p.guid === pet.guid).satiety_val = 0
        assert.equal(workerAssignmentProgressValue(f.tables, hungry, [12247, job, 10000]), 1)
        const duplicate = structuredClone(before)
        duplicate.pets.push({ ...duplicate.pets.find((p) => p.guid === pet.guid), guid: '0' + pet.guid })
        assert.throws(
            () => workerAssignmentProgressValue(f.tables, duplicate, [12247, job, 10000]),
            (e) => e.code === ErrorCode.GameConfig,
        )
        const unrelated = structuredClone(before)
        unrelated.pets.push({ guid: 'not-a-worker-UID' })
        assert.equal(workerAssignmentProgressValue(f.tables, unrelated, [12247, job, 10000]), 1)
        unrelated.home.stationPets = []
        assert.equal(
            workerAssignmentProgressValue(f.tables, unrelated, [12247, job, 10000]),
            0,
            'Empty membership never needs a global roster scan',
        )
        for (const id of ['18446744073709551616', Number.MAX_SAFE_INTEGER + 1]) {
            const bad = structuredClone(before)
            bad.home.stationPets = [id]
            assert.throws(
                () => workerAssignmentProgressValue(f.tables, bad, [12247, job, 10000]),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        const imported = structuredClone(before)
        imported.home.stationPets = []
        for (const row of rows) imported.journey.targets[row.id] = { value: 1, complete: false, claimed: false }
        observeJourney(f.tables, imported, [12247])
        assert(rows.every((row) => imported.journey.targets[row.id].value === 0))
        assert.deepEqual(f.state(), before, 'Pure counter probes do not mutate owned state')
    } finally {
        f.close()
    }
})
test('actual6552 multi-capability permanent pets complete all nine targets and actual9869 rewards remain gated,atomic andonce-only', () => {
    const f = farmHarvestFixture('worker-nine-real')
    try {
        const rows = jobs(f),
            pets = cover(f)
        assert(
            pets.some((p) => abilities(p).size > 1),
            'This exercises the explicit multi-job policy',
        )
        for (const pet of pets) station(f, pet)
        assert(rows.every((row) => raw(f, row.tokens[1]) >= 1 && f.state().journey.targets[row.id].complete))
        assert.equal(new Set(f.state().home.stationPets).size, pets.length)
        const unchanged = f.state()
        station(f, pets[0])
        assert.deepEqual(f.state(), unchanged)
        const tasks = rows.map((row) => journeyModel(f.tables).owner.get(row.id))
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: tasks }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        // Only this unrelated chapter claim is isolated; all nine current
        // worker targets and all membership facts came from the real6552s.
        unlockRewardTab(f)
        const encode = f.protocol.encode,
            before = f.state()
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('worker-reward-ACK')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: tasks }), /worker-reward-ACK/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_worker_reward BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'worker-reward-SQL'); END",
        )
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: tasks }), /worker-reward-SQL/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER fail_worker_reward')
        f.call('JourneyTaskFinish', { u32s: tasks })
        assert(rows.every((row) => f.state().journey.targets[row.id].claimed))
        const reward = f.call('JourneyTaskFinish', { u32s: tasks }).find((p) => p.id === 9869)
        assert.deepEqual(f.protocol.decode(f.protocol.byId.get(9869).rsp, reward.payload).rewards, [])
        for (const pet of pets) station(f, pet, 1)
        assert(rows.every((row) => raw(f, row.tokens[1]) === 0 && f.state().journey.targets[row.id].claimed))
    } finally {
        f.close()
    }
})
test('real6532,6156 and6162 move one multi-job actor throughrest,field,ranch andexit without counting requests or selected jobs', () => {
    const f = farmHarvestFixture('worker-real-role-transfers')
    try {
        const pet = f.state().pets.find((p) => abilities(p).has(5) && abilities(p).has(9) && !abilities(p).has(6)),
            size = f.tables.find('pet_home_talent', pet.config_id).sizeType
        assert(pet)
        const live = productionTables(f.tables)
        const stationRow = live.get('home_building_production').find(
            (row) =>
                String(row.petSize).split('|').map(Number).includes(size) &&
                String(row.laborType)
                    .split('|')
                    .map(Number)
                    .some((id) => abilities(pet).has(id)) &&
                live.find('home_building', row.id) &&
                [2, 8, 10, 12, 24].includes(
                    live
                        .get('home_building_group')
                        .find((g) => g.groupId === live.find('home_building', row.id).groupId)?.type,
                ),
        )
        assert(stationRow)
        const type = live
            .get('home_building_group')
            .find((g) => g.groupId === live.find('home_building', stationRow.id).groupId).type
        f.edit((s) => {
            s.home.level = 4
            s.home.builds.push({
                guid: 800,
                build_id: stationRow.id,
                build_type: type,
                status: 1,
                locate: { block_id: 101, anchor: 6750238, direction: 0 },
            })
        })
        station(f, pet)
        f.edit((s) => (s.pets.find((p) => p.guid === pet.guid).satiety_val = 0))
        assert.equal(raw(f, 5), 1)
        f.call('PetStationed', { build_guid: 800, build_type: 1, pet_guid: pet.guid })
        assert.equal(f.state().pets.find((p) => p.guid === pet.guid).work_status, 1)
        assert.equal(raw(f, 9), 1)
        f.call('PetStationed', { build_guid: 800, build_type: 1, pet_guid: '0', out_hub: false })
        assert.equal(raw(f, 5), 1)
        f.call('ChoseAutoWorkPet', { build_guid: 20, work_type: 1001, pet_guid: pet.guid })
        assert.equal(f.state().pets.find((p) => p.guid === pet.guid).work_status, 5)
        assert.equal(raw(f, 9), 1)
        const before = f.state()
        assert.throws(
            () => f.call('ChoseAutoWorkPet', { build_guid: 20, work_type: 1002, pet_guid: pet.guid }),
            (e) => e.code === ErrorCode.PetLaborNotMatch,
        )
        assert.deepEqual(f.state(), before)
        const block = f.tables.get('home_block').find((row) => row.blockType === 2).id
        f.call('RanchSetPetOption', { block_id: block, work_type: 2, slot: 0, pet_guid: pet.guid })
        assert.equal(f.state().pets.find((p) => p.guid === pet.guid).work_status, 6)
        assert.equal(f.state().home.builds.find((b) => b.guid === 20).auto_info.plant_pet, '0')
        assert.equal(raw(f, 5), 1)
        station(f, pet, 1)
        assert.equal(raw(f, 5), 0)
        assert.equal(raw(f, 9), 0)
        assert.equal(f.state().home.ranches[block].harvest_pet, '0')
    } finally {
        f.close()
    }
})
test('6552 source,11880 andSQL failures roll back membership andprogress;existing pet revision wakes a later ordinary callback', () => {
    const f = farmHarvestFixture('worker-atomic')
    try {
        const pet = cover(f)[0],
            job = [...abilities(pet)][0],
            row = jobs(f).find((r) => r.tokens[1] === job),
            encode = f.protocol.encode,
            before = f.state()
        for (const type of ['SCJourneySync', 'ProtoNullRsp']) {
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('worker-source-codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => station(f, pet), /worker-source-codec/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_worker_source BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'worker-source-SQL'); END",
        )
        assert.throws(() => station(f, pet), /worker-source-SQL/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER fail_worker_source')
        station(f, pet)
        assert.equal(raw(f, job), 1)
        f.edit((s) => {
            s.journey.targets[row.id] = { value: 0, complete: false, claimed: false }
            s.journey.observedSources.pet = s.petRevision - 1
        })
        assert(f.call('ActivityGet').some((p) => p.id === 11880))
        assert.equal(f.state().journey.targets[row.id].complete, true)
        const stationed = f.state()
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'ProtoNullRsp') throw Error('worker-exit-codec')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => station(f, pet, 1), /worker-exit-codec/)
        assert.deepEqual(f.state(), stationed)
        f.protocol.encode = encode
        station(f, pet, 1)
        assert.equal(raw(f, job), 0)
    } finally {
        f.close()
    }
})
test('current real memberships and earned receipts persist after SQLite reopen without leaking to another account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-assignment-')),
        file = path.join(dir, 'state.sqlite')
    let f = farmHarvestFixture('worker-persist', file)
    try {
        for (const pet of cover(f)) station(f, pet)
        unlockRewardTab(f)
        const ids = jobs(f).map((row) => journeyModel(f.tables).owner.get(row.id))
        f.call('JourneyTaskFinish', { u32s: ids })
        const members = structuredClone(f.state().home.stationPets)
        f.close()
        f = farmHarvestFixture('worker-persist', file, { resume: true })
        assert.deepEqual(f.state().home.stationPets, members)
        assert(jobs(f).every((row) => raw(f, row.tokens[1]) >= 1 && f.state().journey.targets[row.id].claimed))
        const other = farmHarvestFixture('worker-persist-other', file)
        try {
            assert(jobs(other).every((row) => raw(other, row.tokens[1]) === 0))
        } finally {
            other.close()
        }
    } finally {
        f.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('worker-assignment-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
