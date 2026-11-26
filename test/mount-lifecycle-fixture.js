import { configuration } from '../src/config.js'
import { Tables, heroData } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import assert from 'node:assert/strict'
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
    if (!resume) {
        // Explicit current producer for only these two owned test mounts.
        // Never append old low-ID pets after the login identity marker exists.
        call('GMCommands', {
            cmds: [500026, 500820].map((id) => ({
                command: Buffer.from(`give 5 ${id} 1`).toString('base64'),
            })),
        })
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = mountTables.get('task').map((t) => ({ task_id: t.id, count: 1 }))
            if (!s.player.heros_info.heros.length) s.player.heros_info.heros.push(heroData(101010, session.id))
            populateParty(s)
            Object.assign(
                s.world,
                mountTables.position(mountTables.get('world_borthpos').find((p) => p.cityId === 101)),
            )
        })
        const mount = store.load(session.id).state.pets.find((pet) => pet.config_id === 500026)
        call('PetSetRoulettePos', { guid: mount.guid, pos: 1 })
    }
    const guid = (configId) => {
        const pet = store.load(session.id).state.pets.find((pet) => pet.config_id === configId)
        assert(pet, `Missing current test mount ${configId}`)
        assert.equal(BigInt(pet.guid) >> 56n, 2n)
        return pet.guid
    }
    return {
        store,
        session,
        time,
        game,
        call,
        guid,
        state: () => store.load(session.id).state,
        mount: (id = '500026') =>
            call('WorldMapPlayerStatus', {
                status: 1,
                arg: ['500026', '500820'].includes(String(id)) ? guid(Number(id)) : id,
            }),
        leave: () => call('WorldMapPlayerStatus', { status: 0, arg: '0' }),
        action: (action = 2) => call('WorldMapPlayerPlayerAction', { action }),
    }
}
