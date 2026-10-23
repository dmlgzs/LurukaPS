import { configuration } from '../../src/config.js'
import { Tables } from '../../src/player.js'
import { Protocol } from '../../src/protocol.js'
import { Store } from '../../src/store.js'
import { Game } from '../../src/game.js'
export function repeatFixture(name, filename = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    let now = 1800000000
    const store = new Store(filename),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now })
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    if (!(state().taskRecords ?? []).some((x) => x.task_id === 106015))
        store.transact(session.id, 0, (s) => {
            ;(s.taskRecords ??= []).push({ task_id: 106015, count: 1 })
            s.player.basic_info.lv = 45
        })
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: {
                            step: state().worldObjects[state().world.map_id + ':' + id]?.state_data?.step ?? 0,
                        },
                    },
                    interact_type: 2,
                },
            ],
        })
    const kill = (id) => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((x) => x.object_id === id)
        return call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((x) => x.uuid)],
            battle_info: enemies.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
    }
    return { config, tables, protocol, store, session, game, state, call, interact, kill, tick: (n) => (now += n) }
}
