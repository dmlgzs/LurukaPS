import assert from 'node:assert/strict'
import { petModelFixture } from './pet-model-fixture.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'

export function homeModelFixture(name, file = ':memory:') {
    const f = petModelFixture(name, file)
    f.store.transact(f.session.id, 0, (s) => {
        s.player.basic_info.lv = 30
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        s.home.level = 4
    })
    f.call('EnterHome')
    const bad = () => f.state().pets.find((p) => p.guid === '500638')
    const oldBad = () => {
        f.legacyBad()
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === '500638')
            for (const h of s.player.heros_info.heros) if (h.pet_id === p.guid) h.pet_id = '0'
            for (const m of s.player.group_mgrs)
                for (const g of m.groups ?? [])
                    for (const slot of g.heros ?? []) if (slot.pet_id === p.guid) slot.pet_id = '0'
            Object.assign(p, { hero_id: '0', work_status: 0, work_build: 0, capacity_id: 0 })
        })
        return bad()
    }
    const production = () => {
        const station = f.tables.find('home_building_production', 20141)
        assert(station)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds.push({
                guid: 991701,
                build_id: 20141,
                build_type: 2,
                status: 1,
                locate: { block_id: 101, anchor: 6750238, direction: 0 },
            })
        })
        const labor = String(station.laborType).split('|').map(Number),
            sizes = String(station.petSize).split('|').map(Number),
            worker = f
                .state()
                .pets.find(
                    (p) =>
                        !p.work_status &&
                        petModelEligibility(f.tables, p.config_id).eligible &&
                        p.labor_infos?.some((l) => labor.includes(l.labor_id) && l.labor_grade > 0) &&
                        sizes.includes(f.tables.find('pet_home_talent', p.config_id)?.sizeType),
                )
        assert(worker, 'seeded current roster has a legal production worker')
        return { worker: worker.guid, guid: 991701 }
    }
    const ranch = () => {
        f.call('EnterHome')
        const ranch = Object.values(f.state().home.ranches)[0],
            worker = f
                .state()
                .pets.find(
                    (p) =>
                        !p.work_status &&
                        petModelEligibility(f.tables, p.config_id).eligible &&
                        f.tables.find('pet_home_talent', p.config_id)?.farmProducts,
                )
        assert(ranch && worker, 'current home/ranch and legal producer exist')
        return { ranch, worker: worker.guid }
    }
    return { ...f, bad, oldBad, production, ranch }
}
