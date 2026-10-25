import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
export function materialClearFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn),
        read = (fn) => store.read(session.id, fn),
        state = () => store.load(session.id).state,
        run = () => read((s) => s.entrust?.run && { ...s.entrust.run })
    edit((s) => {
        s.player.basic_info.lv = 80
        s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '10000'
    })
    const catalog = getEntrustCatalog(tables)
    const interact = (id, complete = true) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete,
                        state_data: {
                            step: read((s) => s.worldObjects[`${s.world.map_id}:${id}`]?.state_data?.step ?? 0),
                        },
                    },
                    interact_type: complete ? 2 : 0,
                },
            ],
        })
    const kill = (id, { pet = false, damage } = {}) => {
        const data = read((s) => ({
            hero: pet ? s.pets[0].guid : s.player.heros_info.heros[0].guid,
            enemies: Object.values(s.combat.entities)
                .filter((e) => e.object_id === id)
                .map((e) => ({ uuid: e.uuid, hp: e.hp })),
        }))
        return call('BattleInfoReduce', {
            uint64_dic: [data.hero, ...data.enemies.map((e) => e.uuid)],
            battle_info: data.enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: damage ?? -e.hp },
            })),
            base_time: '0',
        })
    }
    const begin = (id) => {
        const active = run()
        if (active && active.entrust_id === id && active.battle_complete) call('MultiCampaignRestart')
        else {
            if (active) call('MultiCampaignQuit')
            const row = tables.find('dungeon_material', id)
            call('MultiCampaignCreate', { dungeon_id: row.dungeonId, scene_type: 12 })
        }
        call('MultiCampaignPlayerLoadFinish')
    }
    const advance = () => {
        const r = run(),
            plan = materialStoryPlan(tables, r)
        if (r.materialStory?.phase === 'await_trigger') return interact(r.materialStory.trigger_id, false)
        if (r.materialStory?.phase === 'playing')
            return call('PlayerStoryStop', { story_id: r.materialStory.story_id, op: 1 })
        const stage = catalog.stages(r.entrust_id, 'material').find((s) => s.index === r.stage_index)
        if (!stage) throw Error('No active material stage')
        if (stage.type === 13) return interact(stage.row.id, !(plan && stage.row.id === plan.trigger_id))
        if (stage.type === 50) {
            now++
            return kill(stage.row.id)
        }
        throw Error('Unsupported material test stage ' + stage.type)
    }
    const readyLast = (id) => {
        begin(id)
        const last = catalog
            .stages(id, 'material')
            .filter((s) => s.type === 50)
            .at(-1)
        for (let i = 0; i < 30; i++) {
            const r = run()
            if (r.stage_index === last.index && !['playing', 'await_trigger'].includes(r.materialStory?.phase))
                return last.row.id
            advance()
        }
        throw Error('Last material battle not ready')
    }
    const win = (id) => {
        begin(id)
        for (let i = 0; i < 30 && !run().battle_complete; i++) advance()
        if (!run().battle_complete) throw Error('Material win did not complete')
        return run()
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        call,
        login,
        edit,
        read,
        state,
        run,
        interact,
        kill,
        begin,
        advance,
        win,
        readyLast,
        time: (n) => (now = n),
        now: () => now,
        id: () => session.id,
        chest: () => catalog.chest(run().entrust_id, 'material'),
        close: () => store.close(),
    }
}
