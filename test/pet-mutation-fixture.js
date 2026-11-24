import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData, petGrade } from '../src/pets.js'
import { registerPetMutations } from '../src/handlers/pet-mutation.js'
import { ReplayWindow } from '../src/replay.js'
import { encodeFrame } from '../src/wire.js'

export const mutationTestGuid = '144115188099999998'
export function mutationFixture(name, { count = 3, genes = 1, initialize = true, file = ':memory:' } = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1,
        rolls = [],
        draws = [],
        closed = false
    const game = new Game(protocol, store, tables, {
        clock: () => now,
        rng: (limit) => {
            const value = rolls.length ? rolls.shift() : 0
            draws.push({ limit, value })
            return value
        },
    })
    registerPetMutations(
        (name, handler) => {
            const entry = protocol.byName.get('CSProto' + name)
            if (!entry || game.handlers.has(entry.id)) throw Error('Unexpected private mutation registration')
            game.handlers.set(entry.id, handler)
        },
        tables,
        { privateEnabled: true },
    )
    let session = {},
        lastFrame,
        replay = new ReplayWindow(),
        lastEncoded
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        lastFrame = { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0) }
        const packets = game.dispatch(session, lastFrame)
        lastEncoded = packets.map((p) => encodeFrame({ ...p, pushSeq: p.pushSeq ?? 0 }, p.payload))
        replay.save(lastFrame, lastEncoded)
        return packets
    }
    const login = () => {
        session = {}
        seq = 1
        replay = new ReplayWindow()
        return call('EnterGame', { open_id: name })
    }
    login()
    if (initialize)
        store.transact(session.id, 0, (s) => {
            const pet = petData(tables, 500001, mutationTestGuid, 2001, 1001, () => 0)
            pet.gene_infos = pet.gene_infos.slice(0, genes)
            pet.gene_state = Math.ceil(genes / 2)
            pet.mutation_times = count
            pet.grade = petGrade(tables, pet)
            pet.is_lock = false
            s.pets = [...s.pets.filter((p) => p.guid !== mutationTestGuid), pet]
        })
    draws = []
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        get session() {
            return session
        },
        get lastFrame() {
            return lastFrame
        },
        get draws() {
            return draws
        },
        get lastEncoded() {
            return lastEncoded
        },
        state: () => store.load(session.id).state,
        target: () => store.load(session.id).state.pets.find((p) => p.guid === mutationTestGuid),
        edit: (fn) => store.transact(session.id, 0, fn),
        setRolls: (values) => {
            rolls = [...values]
            draws = []
        },
        call,
        login,
        generate: () => call('UseMutationTimes', { pet_guid: mutationTestGuid }),
        choose: (is_accept) => call('ChoseMutation', { pet_guid: mutationTestGuid, is_accept }),
        replay: (frame) => {
            const cached = replay.find(frame)
            if (!cached) throw Error('No transport replay response for this fixture frame')
            return cached
        },
        now: () => now,
        elapse: (seconds) => {
            now += seconds
        },
        close: () => {
            if (!closed) {
                store.close()
                closed = true
            }
        },
    }
}
export function mutationTemporaryDatabase() {
    const prefix = 'lurukaps-mutation-'
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    return {
        file: path.join(directory, 'state.sqlite'),
        cleanup() {
            const resolved = fs.realpathSync(directory),
                parent = fs.realpathSync(os.tmpdir())
            if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix))
                throw Error('Unsafe mutation test cleanup path')
            fs.rmSync(resolved, { recursive: true, force: true })
        },
    }
}
