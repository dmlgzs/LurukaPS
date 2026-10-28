import test from 'node:test'
import assert from 'node:assert/strict'
import { productionWorkGameFixture } from './production-work-game-fixture.js'
import { completed } from '../src/production.js'
import { workCompare } from '../src/production-work-fractions.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function otherWorker(f, buildId, satiety) {
    let guid
    f.edit((state) => {
        const station = f.tables.find('home_building_production', buildId),
            types = String(station.laborType).split('|').map(Number),
            sizes = String(station.petSize).split('|').map(Number),
            pet = state.pets.find(
                (row) =>
                    row.guid !== f.workerGuid &&
                    (!row.hero_id || row.hero_id === '0') &&
                    !row.work_status &&
                    petModelEligibility(f.tables, row.config_id).eligible &&
                    sizes.includes(f.tables.find('pet_home_talent', row.config_id)?.sizeType) &&
                    row.labor_infos?.some((entry) => types.includes(entry.labor_id)),
            )
        assert(pet, 'A second genuinely eligible owned worker exists in the current roster')
        guid = pet.guid
        Object.assign(pet, { satiety_val: satiety, talent_id: [] })
        pet.labor_infos = pet.labor_infos.map((entry) =>
            types.includes(entry.labor_id) ? { ...entry, labor_grade: 1 } : entry,
        )
    })
    return guid
}

test('real Game work pauses without food, consumes a whole deposited dish and resumes only future work before a real claim', () => {
    const f = productionWorkGameFixture('work-game-pause-resume')
    try {
        f.start(5)
        const seconds = f.job().seconds
        f.advance(2 * seconds)
        assert.equal(completed(f.job(), f.now()), 2)
        assert.equal(f.pet().satiety_val, 0)
        assert.equal(f.pet().work_pause, true)
        assert.equal(f.pet().work_status, 2)
        assert.equal(f.pet().work_build, 1)
        const paused = structuredClone(f.state().home.productionWork)
        f.advance(100)
        assert.equal(completed(f.job(), f.now()), 2)
        assert.deepEqual(f.state().home.productionWork, paused)
        const foodScore = f.tables.find('food', 9002901).satietyScore
        f.addFood()
        assert.equal(f.pet().work_pause, false)
        assert.equal(completed(f.job(), f.now()), 2)
        assert.equal(f.pet().satiety_val, foodScore)
        assert.equal(f.canteen().food_value, 0)
        assert.deepEqual(f.canteen().foods, [])
        assert.deepEqual(f.canteen().food_extra_ids, [77])
        assert.deepEqual(f.canteen().food_extra_values, [88])
        f.advance(3 * f.job().seconds)
        assert.equal(completed(f.job(), f.now()), 5)
        assert.equal(f.pet().satiety_val, foodScore - 3)
        f.call('ProductFinish', { guid: 1, is_all: true })
        assert.equal(f.bag(350000), 5)
        assert.equal(f.bag(300000), 985)
        assert.equal(f.bag(9002901), 99)
        assert.equal(f.state().home.productionJobs[1].length, 0)
    } finally {
        f.close()
    }
})

test('Game food recovery, fee/progress and inventory stay atomic with pending state under HomeSync, pet codec and SQLite failures', () => {
    const f = productionWorkGameFixture('work-game-food-atomic', { satiety: 0 })
    try {
        f.start(2)
        f.advance(20)
        f.store.transact(
            f.session.id,
            0,
            (state) => {
                state.workCandidateMarker = 'pending'
            },
            { defer: true },
        )
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            sql = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved = sql(),
            encode = f.protocol.encode.bind(f.protocol)
        for (const type of ['SCHomeSync', 'SCPetInfoSync', 'ProtoNullRsp']) {
            f.protocol.encode = (name, value) => {
                if (name.split('.').at(-1) === type) throw Error('work-candidate-codec-' + type)
                return encode(name, value)
            }
            assert.throws(() => f.addFood(), new RegExp('work-candidate-codec-' + type))
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(sql(), saved)
        }
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_work_food BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'work-candidate-sql'); END",
        )
        assert.throws(() => f.addFood(), /work-candidate-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(sql(), saved)
        f.store.db.exec('DROP TRIGGER reject_work_food')
        f.addFood()
        assert.equal(f.bag(9002901), 99)
        assert.equal(f.pet().work_pause, false)
        assert.equal(completed(f.job(), f.now()), 0)
    } finally {
        f.close()
    }
})

test('actual half-unit worker replacement apportions the fee and cancellation refunds only unfinished materials', () => {
    const f = productionWorkGameFixture('work-game-worker-cut', { satiety: 60 })
    try {
        const buildId = f.state().home.builds.find((build) => build.guid === 1).build_id,
            next = otherWorker(f, buildId, 60)
        f.start(3)
        assert.equal(f.job().seconds, 2)
        f.advance(1)
        assert.equal(completed(f.job(), f.now()), 0)
        f.call('PetStationed', { pet_guid: next, build_guid: 1, build_type: 1 })
        f.advance(1)
        assert.equal(completed(f.job(), f.now()), 1)
        const work = f.state().home.productionWork
        assert.equal(workCompare(work.pets[f.workerGuid].balance, { n: '119', d: '2' }), 0)
        assert.equal(workCompare(work.pets[next].balance, { n: '119', d: '2' }), 0)
        assert.equal(workCompare(work.stats.spent, 1), 0)
        f.call('ProductCancel', { guid: 1, is_all: true })
        assert.equal(f.bag(350000), 1)
        assert.equal(f.bag(300000), 997)
        assert.equal(workCompare(f.state().home.productionWork.stats.spent, 1), 0)
        assert.equal(f.state().home.productionJobs[1].length, 0)
    } finally {
        f.close()
    }
})

test('two real production buildings share the final dish in stable building order without retroactive recovery', () => {
    const f = productionWorkGameFixture('work-game-shared-food')
    try {
        const secondBuild = 992952,
            buildId = 20231,
            next = otherWorker(f, buildId, 2)
        f.edit((state) =>
            state.home.builds.push({
                guid: secondBuild,
                build_id: buildId,
                build_type: 2,
                status: 1,
                locate: { block_id: 101, anchor: 6750238, direction: 0 },
            }),
        )
        f.call('PetStationed', { pet_guid: next, build_guid: secondBuild, build_type: 1 })
        f.start(5)
        f.call('ProductStart', { build_guid: secondBuild, product_id: 302001, count: 5 })
        const seconds = Math.max(f.job().seconds, f.state().home.productionJobs[secondBuild][0].seconds)
        f.advance(2 * seconds)
        assert.equal(f.pet().work_pause, true)
        assert.equal(f.state().pets.find((pet) => pet.guid === next).work_pause, true)
        f.advance(100)
        f.addFood()
        assert.equal(f.pet().work_pause, false)
        assert.equal(f.state().pets.find((pet) => pet.guid === next).work_pause, true)
        assert.equal(f.canteen().foods.length, 0)
        f.advance(3 * f.job().seconds)
        assert.equal(completed(f.job(), f.now()), 5)
        assert.equal(completed(f.state().home.productionJobs[secondBuild][0], f.now()), 2)
        assert.equal(f.bag(9002901), 99)
    } finally {
        f.close()
    }
})

test('SQLite reopen preserves fractional work and offline settlement matches observed ticks through fatigue and feeding', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'production-work-b295-'))
    assert.equal(path.dirname(path.resolve(dir)), parent)
    let frequent, offline, fractional
    try {
        frequent = productionWorkGameFixture('work-game-frequent', {
            file: path.join(dir, 'frequent.sqlite'),
            satiety: 12,
            laborGrade: 20,
        })
        offline = productionWorkGameFixture('work-game-offline', {
            file: path.join(dir, 'offline.sqlite'),
            satiety: 12,
            laborGrade: 20,
        })
        for (const f of [frequent, offline]) {
            f.addFood()
            f.start(10)
            f.start(10)
        }
        for (let second = 0; second < 100; second++) frequent.advance(1)
        offline.advance(100, false)
        offline.restart()
        assert.equal(frequent.pet().satiety_val, 17)
        assert.equal(offline.pet().satiety_val, 17)
        assert.deepEqual(offline.state().home.productionWork.stats, frequent.state().home.productionWork.stats)
        assert.deepEqual(
            offline.state().home.productionJobs[1].map((job) => [completed(job, offline.now()), job.workProjection]),
            frequent.state().home.productionJobs[1].map((job) => [completed(job, frequent.now()), job.workProjection]),
        )
        assert.equal(offline.bag(9002901), 99)
        fractional = productionWorkGameFixture('work-game-fractional-reopen', {
            file: path.join(dir, 'fractional.sqlite'),
            satiety: 2,
        })
        fractional.start(2)
        fractional.advance(1)
        const balance = structuredClone(fractional.state().home.productionWork.pets[fractional.workerGuid].balance)
        assert.equal(workCompare(balance, { n: '3', d: '2' }), 0)
        fractional.restart()
        assert.deepEqual(fractional.state().home.productionWork.pets[fractional.workerGuid].balance, balance)
        fractional.advance(1)
        assert.equal(fractional.pet().satiety_val, 1)
        assert.equal(completed(fractional.job(), fractional.now()), 1)
    } finally {
        frequent?.close()
        offline?.close()
        fractional?.close()
        assert.equal(path.dirname(path.resolve(dir)), parent)
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
