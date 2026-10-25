import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { EntrustCatalog } from '../src/entrust.js'

export const tables = new Tables(configuration().tables)
export const catalog = new EntrustCatalog(tables)
export function entrustProgressFixture(name, filename = ':memory:') {
    const protocol = new Protocol(configuration().base)
    const store = new Store(filename)
    const session = {}
    let now = 1800000000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    const state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.player.basic_info.lv = 30
        s.world.map_id = 100
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
    })
    const interact = (id) => {
        const s = state()
        return call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: { step: s.worldObjects[`${s.world.map_id}:${id}`]?.state_data?.step ?? 0 },
                    },
                    interact_type: 2,
                },
            ],
        })
    }
    const enter = (id) => {
        call('EnterEntrust', { entrust_id: id })
        call('MultiCampaignPlayerLoadFinish')
        interact(catalog.stages(id)[0].row.id)
    }
    const killWave = () => {
        const s = state()
        const stage = catalog.stages(s.entrust.run.entrust_id).find((r) => r.index === s.entrust.run.stage_index)
        const enemies = Object.values(s.combat.entities).filter((e) => e.object_id === stage.row.id && e.hp > 0)
        if (!enemies.length) throw Error('Test expected active configured enemies')
        const hero = s.player.heros_info.battle_infos.find((h) => h.hp > 0).hero_id
        return call('BattleInfoReduce', {
            uint64_dic: [hero, ...enemies.map((e) => e.uuid)],
            base_time: '0',
            battle_info: enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
        })
    }
    const finish = (id, { elapsed = 0, death = false } = {}) => {
        enter(id)
        if (death) {
            const s = state()
            const first = catalog.stages(id).find((r) => r.index === s.entrust.run.stage_index)
            const enemy = Object.values(s.combat.entities).find((e) => e.object_id === first.row.id)
            const hero = s.player.heros_info.battle_infos.find((h) => h.hp > 0)
            call('BattleInfoReduce', {
                uint64_dic: [enemy.uuid, hero.hero_id],
                base_time: '0',
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hero.hp } }],
            })
        }
        now += elapsed
        let packets
        for (let n = 0; n < 32 && !state().entrust.run.battle_complete; n++) packets = killWave()
        if (!state().entrust.run.battle_complete) throw Error('Test expected completed configured waves')
        return packets
    }
    const quit = () => {
        call('CampaignQuit')
        call('WorldMapPlayerRevive')
    }
    return {
        protocol,
        store,
        session,
        game,
        call,
        edit,
        state,
        enter,
        killWave,
        finish,
        quit,
        advance: (seconds) => {
            now += seconds
        },
        close: () => store.close(),
    }
}
