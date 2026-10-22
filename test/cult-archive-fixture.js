import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration()
export function fixture(name = 'growup-archive', file = ':memory:', resume = false) {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
    let seq = 1
    const call = (name, r = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: p.id,
            seq: seq++,
            payload: p.req ? protocol.encode(p.req, r) : Buffer.alloc(0),
        })
    }
    const decode = (packets, name) => {
        const p = protocol.byName.get(name)
        return protocol.decode(p.rsp, packets.find((x) => x.id === p.id).payload)
    }
    const login = call('EnterGame', { open_id: name })
    if (!resume)
        store.transact(session.id, 0, (s) => {
            s.taskRecords = [106010, 106013, 404002].map((task_id) => ({ task_id, count: 1 }))
            s.tasks = s.tasks.filter((t) => t.task_id !== 404002)
        })
    if (!resume) call('ActivityGet')
    const state = () => store.load(session.id).state,
        g = () => state().activities[60001].growup
    const start = () =>
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    // Trusted persisted-result fixture, not a claim that a live client earned it.
    // It uses the existing finish producer and configured final trials/score policy.
    const complete = (values = [1000, 1000, 1000, 1000]) =>
        store.transact(session.id, 0, (s) => {
            const entry = s.activities[60001],
                run = entry.growup,
                system = game.activities.growup
            run.growup_train_attr.forEach((attr, index) => {
                attr.attr_value = values[index]
            })
            Object.assign(run, { cur_stage: 3, cur_growup_stage: 13, cur_growup_trail_stage: 3, select_trail_id: 301 })
            run.trails = [101, 201, 301].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: run.guid }))
            system.finish(
                run,
                60001,
                system.tables.get('game_events_cul_trial').find((x) => x.trialId === 301 && x.systemId === 60001),
            )
            s.acceptedCultTrials = {
                ...s.acceptedCultTrials,
                ...Object.fromEntries(run.trails.map((result) => [run.guid + ':' + result.trail_id, true])),
            }
        })
    return { tables, protocol, store, game, session, call, decode, state, g, start, complete, login }
}
