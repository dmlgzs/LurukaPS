import { configuration } from '../src/config.js'
import { Tables, heroData } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'
import { populateParty } from './party-fixture.js'
export const mountConfig = configuration(),
    mountTables = new Tables(mountConfig.tables),
    mountProtocol = new Protocol(mountConfig.base)
export function mountLifecycleFixture(name = 'mount-lifecycle', file = ':memory:', resume = false) {
    const store = new Store(file, { flushIntervalMs: 60000 }),
        session = {},
        time = { now: 1800000000 },
        game = new Game(mountProtocol, store, mountTables, { clock: () => time.now })
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = mountProtocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: mountProtocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: name })
    if (!resume)
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = mountTables.get('task').map((t) => ({ task_id: t.id, count: 1 }))
            if (!s.player.heros_info.heros.length) s.player.heros_info.heros.push(heroData(101010, session.id))
            populateParty(s)
            Object.assign(
                s.world,
                mountTables.position(mountTables.get('world_borthpos').find((p) => p.cityId === 101)),
            )
            for (const [id, guid] of [
                [500026, '500026'],
                [500820, '500820'],
            ])
                if (!s.pets.some((p) => p.guid === guid)) s.pets.push(petData(mountTables, id, guid, 1))
            s.pets.find((p) => p.guid === '500026').roulette_pos = 1
            s.mountRideId = '500026'
        })
    return {
        store,
        session,
        time,
        game,
        call,
        state: () => store.load(session.id).state,
        mount: (id = '500026') => call('WorldMapPlayerStatus', { status: 1, arg: id }),
        leave: () => call('WorldMapPlayerStatus', { status: 0, arg: '0' }),
        action: (action = 2) => call('WorldMapPlayerPlayerAction', { action }),
    }
}
