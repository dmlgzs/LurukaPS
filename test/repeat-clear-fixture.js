import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { repeatEventTables } from '../src/repeat-event.js'

export function repeatClearFixture(name, filename = ':memory:', options = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(filename)
    options.configureTables?.(tables)
    let now = options.now ?? 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        if (!entry) throw Error('Unknown fixture protocol ' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const read = (fn) => store.read(session.id, fn),
        edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((state) => {
        state.player.basic_info.lv = 80
        state.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '10000'
        if (!(state.taskRecords ?? []).some((row) => row.task_id === 106015))
            (state.taskRecords ??= []).push({ task_id: 106015, count: 1 })
    })
    const current = repeatEventTables(tables),
        catalog = getEntrustCatalog(tables)
    const run = () => read((state) => state.entrust?.run && structuredClone(state.entrust.run))
    const request = (level) => {
        const row = current.find('repeat_event_level', level)
        const chapter = current.get('repeat_event_chapter').find((entry) => entry.levelGroup === row.group)
        const activity = current.get('repeat_event_activity').find((entry) => entry.chapterGroup === chapter.group)
        return { activity: activity.gameEventsId, chapter: chapter.id, level, mode: 1 }
    }
    const exit = () => {
        if (run()) return call('MultiCampaignQuit')
    }
    const begin = (level) => {
        const active = run(),
            next = request(level)
        if (active?.kind === 'repeat' && active.repeat_event.level === level) call('RepeatEventReEnterLevelReq', next)
        else {
            exit()
            call('RepeatEventEnterLevelReq', next)
        }
        call('MultiCampaignPlayerLoadFinish')
    }
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: {
                            step: read(
                                (state) => state.worldObjects[`${state.world.map_id}:${id}`]?.state_data?.step ?? 0,
                            ),
                        },
                    },
                    interact_type: 2,
                },
            ],
        })
    const kill = (id, { pet = false, damage } = {}) => {
        const actors = read((state) => ({
            from: pet ? state.pets[0].guid : state.player.heros_info.heros[0].guid,
            enemies: Object.values(state.combat.entities)
                .filter((row) => row.object_id === id)
                .map(({ uuid, hp }) => ({ uuid, hp })),
        }))
        return call('BattleInfoReduce', {
            uint64_dic: [actors.from, ...actors.enemies.map((row) => row.uuid)],
            base_time: '0',
            battle_info: actors.enemies.map((row, index) => ({
                hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: damage ?? -row.hp },
            })),
        })
    }
    const advance = (options) => {
        const active = run(),
            stage = catalog.stages(active.entrust_id, active.kind).find((row) => row.index === active.stage_index)
        if (stage?.type === 13) return interact(stage.row.id)
        if (stage?.type === 50) {
            now++
            return kill(stage.row.id, options)
        }
        throw Error('No active repeat fixture stage')
    }
    const finish = (options) => {
        for (let index = 0; index < 32 && !run().battle_complete; index++) advance(options)
        if (!run()?.battle_complete) throw Error('Repeat fixture victory incomplete')
        return run()
    }
    const win = (level, options) => {
        begin(level)
        return finish(options)
    }
    const unlockThrough = (level) => {
        const row = current.find('repeat_event_level', level)
        const predecessor = row.preLevel
        if (
            predecessor &&
            read(
                (state) =>
                    (state.repeatEvent?.levels?.[
                        `${request(predecessor).activity}:${predecessor}`
                    ]?.mode_save_data?.find((entry) => entry.mode === row.preLevelDiff)?.star_count ?? 0) <= 0,
            )
        )
            unlockThrough(predecessor)
        return win(level)
    }
    const readyLast = (level) => {
        begin(level)
        const last = catalog
            .stages(run().entrust_id, 'repeat')
            .filter((stage) => stage.type === 50)
            .at(-1)
        for (let index = 0; index < 32; index++) {
            if (run().stage_index === last.index) return last.row.id
            advance()
        }
        throw Error('Repeat final wave unavailable')
    }
    const otherWin = (kind, id) => {
        exit()
        if (kind === 'entrust') call('EnterEntrust', { entrust_id: id })
        else if (kind === 'material')
            call('MultiCampaignCreate', { dungeon_id: tables.find('dungeon_material', id).dungeonId, scene_type: 12 })
        else throw Error('Unsupported fixture alternate domain')
        call('MultiCampaignPlayerLoadFinish')
        return finish()
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        call,
        login,
        read,
        edit,
        state,
        run,
        current,
        catalog,
        request,
        exit,
        begin,
        interact,
        kill,
        advance,
        finish,
        win,
        unlockThrough,
        readyLast,
        otherWin,
        now: () => now,
        time: (value) => (now = value),
        id: () => session.id,
        chest: () => catalog.chest(run().entrust_id, run().kind),
        close: () => store.close(),
    }
}
