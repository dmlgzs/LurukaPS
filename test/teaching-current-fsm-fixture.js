import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'

// Current-mechanics integration fixture only. Observation vectors and IR
// contract checks belong to the separate tests once Main installs that IR.
export function currentTeachingFsmFixture(taskId) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    let nowMs = 1800000000000,
        sequence = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000), arenaClockMs: () => nowMs })
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get(name) ?? protocol.byName.get('CSProto' + name)
        if (!entry) throw Error('Missing current teaching request ' + name)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        }
    }
    const dispatch = (message) => game.dispatch(session, message),
        call = (name, request) => dispatch(frame(name, request))
    call('EnterGame', { open_id: 'current-teaching-fsm-' + taskId })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1)
            .map((row) => ({ task_id: row.id, count: 1 }))
        s.player.basic_info.lv = 60
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
    })
    const initialAssets = structuredClone({
        heroes: state().player.heros_info.heros,
        pets: state().pets,
        bag: state().player.sbag_infos,
        souls: state().player.soulessence_infos,
        ornaments: state().ornaments,
    })
    const entryPackets = call('TeachStart', { id: taskId }),
        scene = tables.find('dungeon_scene', state().world.map_id)
    const rosterPackets = call('TrialGroupChange', { open: true, trial_id: scene.trialsId })
    const loadingPackets = call('StartDungeonClientOk')
    return {
        tables,
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        edit,
        state,
        entryPackets,
        rosterPackets,
        loadingPackets,
        scene,
        initialAssets,
        nowMs: () => nowMs,
        advanceMs: (ms) => {
            if (!Number.isSafeInteger(ms) || ms < 0) throw Error('Invalid current teaching fixture clock advance')
            nowMs += ms
        },
        trialActor: (heroId) => {
            const rows = state().trialGroup?.heroes.filter((hero) => hero.conf_id === heroId) ?? []
            if (rows.length !== 1) throw Error('Current teaching actor is missing or ambiguous ' + heroId)
            return rows[0]
        },
        playerActorId: () => ((24n << 56n) | BigInt(state().player.basic_info.id)).toString(),
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: 'current-teaching-fsm-' + taskId, reconnect: true })
        },
    }
}
