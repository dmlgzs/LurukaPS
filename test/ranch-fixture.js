import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { technologyState, technologyPoints } from '../src/technology.js'

export function ranchFixture(name, options = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        roll = () => 0
    const game = new Game(protocol, store, tables, { clock: () => now, rng: (max) => roll(max) })
    const session = {}
    const request = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        if (!e) throw Error('Unknown current test protocol: ' + name)
        return {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        }
    }
    const call = (name, data = {}, target = session) => game.dispatch(target, request(name, data))
    call('EnterGame', { open_id: name })
    let pets
    store.transact(session.id, 0, (s) => {
        s.world.map_id = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
        s.player.basic_info.lv = options.level ?? 15
        // Current pageHomeRanchNew checks system171: task106010 node195 AND lv15.
        // This is a legitimate saved-story prerequisite fixture, not earned play.
        s.taskRecords = [
            ...(s.taskRecords ?? []).filter((row) => row.task_id !== 106010),
            { task_id: 106010, count: 1 },
        ]
        pets = createPets(tables, s, 500001, options.pets ?? 2).map((p) => p.guid)
        for (const p of s.pets.filter((p) => pets.includes(p.guid))) {
            p.work_status = 0
            p.work_build = 0
            p.capacity_id = 0
            p.labor_infos = []
            p.talent_id = []
            p.satiety_val = 10000
        }
        // This fixture bypasses the real LvUp dispatcher by directly setting
        // player.lv. Reconcile level-gated automatic technology before testing
        // worker idempotency, as the normal HomeSync payload does. Otherwise
        // its first HomeSync adds nodes after notifyJourney cached homeRevision,
        // and a second no-op assignment legitimately observes the new revision.
        technologyState(tables, s)
        // The versioned technology point ledger also derives its total from
        // this controlled level change. Reconcile it before idempotency checks,
        // as the normal level-up dispatcher does, rather than during HomeSync.
        technologyPoints(tables, s)
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        pets,
        call,
        request,
        now: () => now,
        productionPeriod: () => {
            const clocks = store
                .load(session.id)
                .state.home.ranches[201].product_pets.flatMap((slot) => slot.drop_times)
            if (!clocks.length || clocks.some((clock) => !Number.isSafeInteger(clock.seconds) || clock.seconds <= 0))
                throw Error('Missing current ranch period')
            return Math.min(...clocks.map((clock) => clock.seconds))
        },
        state: () => store.load(session.id).state,
        close: () => store.close(),
        now: () => now,
        setRoll: (fn) => {
            roll = fn
        },
        elapse: (seconds) => {
            now += seconds
        },
        tick: () => game.tick(session.id),
        assign: (pet = pets[0], slot = 1, role = 1) =>
            call('RanchSetPetOption', { block_id: 201, slot, pet_guid: pet, work_type: role }),
    }
}
