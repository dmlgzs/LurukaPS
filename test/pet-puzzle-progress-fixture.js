import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { reconcileHomeStage } from '../src/home-stage.js'
import { worldCondition } from '../src/handlers/world-objects.js'
import policy from '../configs/pet-puzzle-progress-policy.json' with { type: 'json' }
const cfg = configuration()
export const puzzleTables = new Tables(cfg.tables)
export const puzzleProtocol = new Protocol(cfg.base)
export const puzzleWorld = new WorldObjectCatalog(puzzleTables)
export const puzzlePolicy = policy
export const playableRows = JSON.parse(
    fs.readFileSync(new URL('../configs/playable-tables/playable.json', import.meta.url)),
)
export function puzzleFixture(name, file = ':memory:', setup = true) {
    const store = new Store(file),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(puzzleProtocol, store, puzzleTables, { clock: () => now, rng: () => 0 })
    const call = (name, data = {}, who = session) => {
        const row = puzzleProtocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: row.id, seq: seq++, payload: puzzleProtocol.encode(row.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: puzzleProtocol.decode(puzzleProtocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, now, fn)
    try {
        call('EnterGame', { open_id: name })
        if (setup)
            edit((s) => {
                // Only legitimate quest/home prerequisites are isolated. No puzzle
                // completion, typed fact, or achievement receipt is imported.
                s.tasks = []
                s.taskRecords = puzzleTables.get('task').map((r) => ({ task_id: r.id, count: 1, time: 1 }))
                reconcileHomeStage(puzzleTables, s)
                delete s.pendingTaskStorySync
            })
        const context = (attribute) => {
            const pet = state().pets.find((p) =>
                String(puzzleTables.find('pet', p.config_id)?.element).split('|').map(Number).includes(attribute),
            )
            if (!pet) throw Error('No seeded pet for configured element ' + attribute)
            return { ext_type: 1, ext_uint32_1: attribute, ext_uint64_1: pet.guid }
        }
        const worldEntries = () =>
            policy.worlds.filter((e) => {
                // Some shipped rows retain a foreign cityId in another map
                // file. The existing actual dispatcher cannot resolve those.
                if (puzzleWorld.find('worldmap_' + e.map, e.id)?.cityId !== e.map) return false
                const { row } = puzzleWorld.object(e.map, e.id)
                return (
                    !row.initialCompleteState &&
                    worldCondition(row.appearCond, state()) &&
                    (!row.disappearCond || !worldCondition(row.disappearCond, state()))
                )
            })
        const near = (entry) =>
            edit((s) => {
                s.world.map_id = entry.map
                s.world.pos = puzzleWorld.object(entry.map, entry.id).pos
            })
        const request = (entry, ctx = context(entry.attribute)) => ({
            obj: { obj_id: entry.id, complete: true, state_data: { step: 1, complete: true } },
            interact_type: 0,
            ...(ctx === null ? {} : { ext_context: ctx }),
        })
        const finishWorld = (entry, ctx) => {
            near(entry)
            return call('WorldObjInteract', { objs: [request(entry, ctx)] })
        }
        return {
            store,
            session,
            game,
            call,
            state,
            edit,
            context,
            worldEntries,
            near,
            request,
            finishWorld,
            advance: (delta) => {
                now += delta
            },
            close: () => store.close(),
        }
    } catch (error) {
        store.close()
        throw error
    }
}
