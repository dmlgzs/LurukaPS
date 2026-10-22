import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { hatchSeconds } from '../src/hatching-time.js'
import { ErrorCode } from '../src/error-codes.js'
import { tables, protocol, setup, station, start, jobs } from './hatching-workers-fixture.js'
test('actual hatch labor uses EggTimeReduct plus element-matched talent, then 6102/6517 sync before acceptance', () => {
    const f = setup()
    try {
        const before = station(f)
        assert(
            before.some(
                (p) => p.id === 6102 && p.data.home_builds.find((b) => b.guid === 18).station_pet_guid === f.worker,
            ),
        )
        assert(before.some((p) => p.id === 6517))
        const worker = f.state().pets.find((p) => p.guid === f.worker),
            grade = worker.labor_infos.find((r) => r.labor_id === 9).labor_grade
        const expected = Math.floor(
            18000 * (1 - tables.find('home_labor_efficiency', grade).EggTimeReduct / 10000) - 360,
        )
        assert.notEqual(
            expected,
            Math.floor(18000 * (1 - tables.find('home_labor_efficiency', grade).TimeReduct / 10000) - 360),
        )
        const packets = start(f)
        assert.equal(jobs(f)[0].seconds, expected)
        const sync = packets.findIndex((p) => p.id === 6102),
            ack = packets.findIndex((p) => p.id === 6506)
        assert(sync >= 0 && ack >= 0 && sync < ack)
        assert.equal(f.state().pets.find((p) => p.guid === f.worker).work_status, 2)
        f.advance(expected - 1)
        assert.throws(() => f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }), /not finished/)
        f.advance(1)
        const result = f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }).find((p) => p.id === 6507).data
        assert.equal(f.state().pets.find((p) => p.guid === result.pet_guid).config_id, 500609)
        assert.equal(f.state().pets.find((p) => p.guid === f.worker).work_status, 1)
    } finally {
        f.close()
    }
})
test('fatigue reduces hatch labor only, while the current talent is preserved', () => {
    const f = setup()
    try {
        station(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.worker).satiety_val = 10
        })
        start(f)
        const worker = f.state().pets.find((p) => p.guid === f.worker),
            grade = worker.labor_infos.find((r) => r.labor_id === 9).labor_grade
        assert.equal(
            jobs(f)[0].seconds,
            Math.floor(18000 * (1 - (tables.find('home_labor_efficiency', grade).EggTimeReduct / 10000) * 0.4) - 360),
        )
    } finally {
        f.close()
    }
})
test('station changes preserve elapsed hatch work and serial queue, and cancellation never rerolls species', () => {
    const f = setup()
    try {
        start(f)
        start(f, 2)
        const selected = f.state().eggOutcomes[1]
        f.advance(9000)
        station(f)
        let [first, second] = jobs(f)
        assert.equal(first.start, Math.ceil(f.now() - first.seconds / 2))
        assert.equal(second.start, first.start + first.seconds)
        assert.equal(f.state().home.builds.find((b) => b.guid === 18).hatch.hatch_infos[1].start_time, 0)
        f.call('PetStationed', { pet_guid: '0', build_guid: 18, build_type: 1 })
        ;[first, second] = jobs(f)
        assert.equal(first.seconds, 18000)
        assert(Math.abs((f.now() - first.start) / 18000 - 0.5) < 1 / 10000)
        assert.equal(second.start, first.start + 18000)
        f.call('CancelHatchPetEgg', { build_guid: 18, egg_guid: 1 })
        assert.equal(f.state().eggOutcomes[1], selected)
        start(f)
        assert.equal(f.state().eggOutcomes[1], selected)
    } finally {
        f.close()
    }
})
test('invalid station labor and locked/affixed eggs roll back without consuming queued state', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.worker).labor_infos = [{ labor_id: 5, labor_grade: 20 }]
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => station(f),
            (e) => e.code === ErrorCode.PetLaborNotMatch,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.worker).labor_infos = [{ labor_id: 9, labor_grade: 20 }]
        })
        station(f)
        f.call('PetEggLock', { guid: '1', lock_operate: true })
        before = f.store.load(f.session.id)
        assert.throws(() => start(f), /locked/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.call('PetEggLock', { guid: '1', lock_operate: false })
        f.store.transact(f.session.id, 0, (s) => {
            s.petEggs[0].egg_affix = [1]
        })
        before = f.store.load(f.session.id)
        assert.throws(() => start(f), /Affix/)
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('minimum duration and proportional/fixed combination follow actual formula; future unsupported merges fail explicitly', () => {
    const build = { guid: 1, build_id: 30231, station_pet_guid: '9' },
        state = {
            pets: [
                {
                    guid: '9',
                    work_build: 1,
                    talent_id: [50010210],
                    labor_infos: [{ labor_id: 9, labor_grade: 100 }],
                    satiety_val: 10000,
                },
            ],
            home: { technology: { levels: {} } },
        }
    assert.equal(hatchSeconds(tables, state, build, { eggTime: 100, element: 1 }), 5)
    assert.equal(hatchSeconds(tables, state, build, { eggTime: 18000, element: 99 }), 3599)
    const bad = {
        get: tables.get.bind(tables),
        find: (n, id) => (n === 'home_buff' ? { ...tables.find(n, id), algorithmType: 9 } : tables.find(n, id)),
    }
    assert.throws(
        () => hatchSeconds(bad, state, build, { eggTime: 18000, element: 1 }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})
test('response encoding failure rolls back the hatch queue, egg, worker status and sampled species', () => {
    const f = setup()
    try {
        station(f)
        const before = f.store.load(f.session.id),
            encode = protocol.encode
        // Use the actual response schema rather than relying on a guessed empty type.
        const response = protocol.byName.get('CSProtoHatchPetEgg').rsp
        protocol.encode = function (type, data) {
            if (type === response) throw Error('injected hatch response')
            return encode.call(this, type, data)
        }
        try {
            assert.throws(() => start(f), /injected hatch response/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(f.store.load(f.session.id), before)
        start(f)
        assert.equal(jobs(f).length, 1)
    } finally {
        f.close()
    }
})
test('completed hatch timestamps do not change when a helper is removed', () => {
    const f = setup()
    try {
        station(f)
        start(f)
        f.advance(jobs(f)[0].seconds)
        const completed = structuredClone(jobs(f)[0])
        f.call('PetStationed', { pet_guid: '0', build_guid: 18, build_type: 1 })
        assert.equal(jobs(f)[0].seconds, completed.seconds)
        assert.equal(jobs(f)[0].start, completed.start)
        f.call('ProductFinish', { guid: 18, product_guids: [completed.guid] })
        assert.equal(jobs(f).length, 0)
    } finally {
        f.close()
    }
})
test('file-backed restart retains helper, modified hatch timing and selected species without reroll', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-hatch-helper-')),
        file = path.join(dir, 'db.sqlite')
    let f = setup(file),
        store = f.store
    try {
        station(f)
        start(f)
        const id = f.session.id,
            seconds = jobs(f)[0].seconds,
            selected = f.state().eggOutcomes[1]
        f.close()
        store = new Store(file)
        const game = new Game(protocol, store, tables, {
                clock: () => 1800000000 + seconds,
                rng: () => {
                    throw Error('unexpected species reroll')
                },
            }),
            session = {},
            login = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: login.id,
            seq: 1,
            payload: protocol.encode(login.req, { open_id: 'hatch-workers' }),
        })
        assert.equal(session.id, id)
        assert.equal(store.load(id).state.home.productionJobs[18][0].seconds, seconds)
        assert.equal(store.load(id).state.eggOutcomes[1], selected)
        const entry = protocol.byName.get('CSProtoHatOutPetEgg')
        game.dispatch(session, {
            id: entry.id,
            seq: 2,
            payload: protocol.encode(entry.req, { build_guid: 18, egg_guid: 1 }),
        })
        assert.equal(store.load(id).state.petEggs.length, 1)
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-hatch-helper-'))
        fs.rmSync(dir, { recursive: true })
    }
})
