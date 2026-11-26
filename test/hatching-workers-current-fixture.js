import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { gridAnchor } from '../src/home-grid.js'

export function setupHatchWorker(name) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        worker,
        eggIds
    const game = new Game(protocol, store, tables, {
            starterProfile: 'sandbox',
            clock: () => now,
            arenaClockMs: () => now * 1000,
            rng: () => 0,
        }),
        session = {}
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        if (!e) throw Error('Current protocol unavailable: ' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0) }
    }
    const dispatch = (request) =>
        game.dispatch(session, request).map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    const call = (name, data = {}) => dispatch(frame(name, data)),
        state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
    // Explicit qualified production-management inventory, not normal startup.
    // Only ordinary eggs/cards; never insert a fake build or change map701.
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 15
        const rewards = grantRewards(
            tables,
            s,
            [
                { itemtype: 13, itemid: 30231, itemnum: 1 },
                { itemtype: 5, itemid: 500023, itemnum: 1 },
                { itemtype: 14, itemid: 20004001, itemnum: 3 },
                { itemtype: 3, itemid: 1000001, itemnum: 5 },
                { itemtype: 3, itemid: 1000002, itemnum: 3 },
            ],
            0,
            { randomInt: () => 0 },
        )
        worker = rewards.find((r) => r.itemtype === 5).guid
        eggIds = rewards.filter((r) => r.itemtype === 14).map((r) => Number(r.guid))
    })
    const located = call('BuildLocate', {
        build_id: 30231,
        locate: { block_id: 101, anchor: gridAnchor(-50, -25), direction: 0 },
    })
    const build = () => state().home.builds.find((row) => row.build_id === 30231 && row.build_type === 12)
    if (!build()?.locate) throw Error('Actual BuildLocate did not place a hatch building')
    call('SetDefaultCatchCard', { catch_card_id: 1000001 })
    call('SetEggCatchCard', { egg_guid: eggIds[0], catch_card_id: 1000001 })
    const station = (guid) =>
        call('PetStationed', { build_guid: build().guid, pet_guid: guid ?? worker, build_type: 1 })
    const start = (id = eggIds[0]) => call('HatchPetEgg', { build_guid: build().guid, egg_guid: id })
    const jobs = () => state().home.productionJobs?.[build().guid] ?? []
    const amount = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    return {
        tables,
        protocol,
        store,
        game,
        session,
        frame,
        dispatch,
        call,
        state,
        build,
        located,
        worker,
        eggIds,
        station,
        start,
        jobs,
        amount,
        advance: (n) => {
            now += n
            return game.tick(session.id, session)
        },
        now: () => now,
        raw: () => ({
            state: store.load(session.id),
            sql: store.db.prepare('SELECT state,revision,updated_at FROM players WHERE account_id=?').get(session.id),
            logs: store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
            sequences: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        }),
        grant: (rewards) => store.transact(session.id, 0, (s) => grantRewards(tables, s, rewards)),
        close: () => store.close(),
    }
}

// Independent reference of current Lua PetStore.getEggIncubationTime673–714:
// base*(1-percent)-fixed, EggTimeReduct labor component, then floor/minimum.
export function luaHatchDuration(f, eggId = 20004001) {
    const state = f.state(),
        egg = f.tables.find('pet_egg', eggId),
        build = f.build(),
        worker = state.pets.find((p) => p.guid === build.station_pet_guid)
    const rows = (worker?.talent_id ?? []).map((id) => f.tables.get('home_talent').find((row) => row.talentId === id))
    rows.push(
        ...f.tables
            .get('home_technology')
            .filter((row) => state.home.technology?.levels?.[row.type]?.level === row.level),
    )
    let fixed = 0,
        percent = 0
    for (const row of rows) {
        if (!row) throw Error('Current worker talent missing')
        const terms = String(row.buffCondition ?? '')
                .split('|')
                .filter(Boolean)
                .map((x) => x.split('#').map(Number)),
            matches = ([key, wanted]) => key === 2023 && wanted === egg.element
        if (!(row.buffConditionLogic === 2 ? terms.some(matches) : terms.every(matches))) continue
        const ids = String(row.buffId ?? '')
                .split('|')
                .map(Number),
            values = String(row.buffParams ?? '')
                .split('|')
                .map(Number)
        for (const [i, id] of ids.entries()) {
            if (id === 4001) fixed += values[i]
            if (id === 4002) percent += values[i] / 10000
        }
    }
    let laborPercent = 0
    if (worker) {
        const allowed = String(f.tables.find('home_building_production', build.build_id).laborType)
                .split('|')
                .map(Number),
            labor = worker.labor_infos.filter((row) => allowed.includes(row.labor_id) && row.labor_grade > 0).at(-1)
        if (!labor) throw Error('No current hatch labor')
        laborPercent = Math.max(0, f.tables.find('home_labor_efficiency', labor.labor_grade).EggTimeReduct) / 10000
        const constant = (title) => Number(f.tables.get('game').find((row) => row.title === title).value)
        if (worker.satiety_val < constant('PET_HOME_TIRED_SATIETY'))
            laborPercent *= constant('HOME_LABOR_EGG_DECREASE') / 10000
        percent += laborPercent
    }
    const minimum = Number(f.tables.get('game').find((row) => row.title === 'HOME_HATCH_BOTTOM_TIME').value)
    return {
        seconds: Math.max(minimum, Math.floor(egg.eggTime * (1 - percent) - fixed)),
        base: egg.eggTime,
        fixed,
        percent,
        laborPercent,
        element: egg.element,
    }
}
