import test from 'node:test'
import assert from 'node:assert/strict'
import { hatchSeconds } from '../src/hatching-time.js'
import { tables, protocol, setup, start, jobs } from './hatching-workers-fixture.js'
function importedHelper(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.home.builds.find((b) => b.guid === 18).station_pet_guid = f.worker
        const pet = s.pets.find((p) => p.guid === f.worker)
        pet.work_build = 18
        pet.work_status = 1
        s.home.stationPets = [...new Set([...(s.home.stationPets ?? []), f.worker])]
    })
}
test('6506 consumes a valid persisted hatch helper with the real Lua duration and both claim routes', () => {
    const f = setup()
    try {
        importedHelper(f)
        const before = f.state().pets.length
        start(f)
        assert.equal(jobs(f)[0].seconds, 12497)
        assert.equal(jobs(f)[0].start, f.now())
        f.advance(12497)
        const pet = f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }).find((p) => p.id === 6507).data.pet_guid
        assert(f.state().pets.some((p) => p.guid === pet))
        start(f, 2)
        const guid = jobs(f)[0].guid
        f.advance(jobs(f)[0].seconds)
        f.call('ProductFinish', { guid: 18, product_guids: [guid] })
        assert.equal(f.state().pets.length, before + 2)
        assert.equal(f.state().petEggs.length, 0)
    } finally {
        f.close()
    }
})
test('6506 retains the old queue on real response encoding failure then accepts an atomic retry', () => {
    const f = setup()
    try {
        importedHelper(f)
        const before = f.store.load(f.session.id),
            encode = protocol.encode,
            rsp = protocol.byName.get('CSProtoHatchPetEgg').rsp
        protocol.encode = function (type, data) {
            if (type === rsp) throw Error('hatch response encode failed')
            return encode.call(this, type, data)
        }
        try {
            assert.throws(() => start(f), /hatch response encode failed/)
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
test('6506 duration reads fatigue, element condition and the configured minimum without a fixed aptitude', () => {
    const f = setup()
    try {
        importedHelper(f)
        const state = f.state(),
            build = state.home.builds.find((b) => b.guid === 18),
            worker = state.pets.find((p) => p.guid === f.worker),
            config = tables.find('pet_egg', 40003007)
        assert.equal(hatchSeconds(tables, state, build, config), 12497)
        worker.satiety_val = 10
        assert.equal(hatchSeconds(tables, state, build, config), 15582)
        worker.satiety_val = 10000
        assert.equal(hatchSeconds(tables, state, build, { ...config, eggTime: 100 }), 5)
        assert.equal(hatchSeconds(tables, state, build, { ...config, element: 99 }), 12857)
    } finally {
        f.close()
    }
})
