import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import assert from 'node:assert/strict'
import { TaskGraphs } from '../src/tasks.js'
import { group } from '../src/handlers/common.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { combatEntityStates } from '../src/combat-enemy-lifecycle.js'

const qualificationCache = new WeakMap()
function pastMainQualification(tables) {
    if (qualificationCache.has(tables)) return qualificationCache.get(tables)
    const graphs = new TaskGraphs(tables),
        ids = new Set()
    const visit = (id) => {
        if (ids.has(id)) return
        const row = tables.find('task', id)
        assert(row, 'Trusted past prerequisite must exist in current task data')
        const graph = graphs.get(id) // Validate the actual current graph; no old asset fallback.
        ids.add(id)
        for (const token of String(row.unlockcondition).split('|')) {
            const [kind, target] = token.split('#').map(Number)
            if (kind === 2007) visit(target)
        }
        for (const condition of graph.requirements)
            if (condition.conditionId === 2007)
                visit(condition.__type_TaskConditionBaseData.__type_TaskCondCompleteTaskData.taskId)
    }
    for (const row of tables.get('task')) if (row.type === 1) visit(row.id)
    qualificationCache.set(tables, ids)
    return ids
}
export function materialClearFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1,
        session = {}
    let reportTimeMs = 0n
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
        // Explicit trusted endgame background, not a replay of every story or
        // its rewards. No material clear,15010,consumer or reward fact is set.
        // The real NPC24→9510 prerequisite control remains independently tested
        // in material-dungeon-unlocks-current/accessory-production.
        const past = pastMainQualification(tables)
        s.tasks = s.tasks.filter((task) => !past.has(task.task_id))
        s.taskRecords ??= []
        for (const task_id of past) {
            const saved = s.taskRecords.find((row) => row.task_id === task_id)
            if (!saved) s.taskRecords.push({ task_id, count: 1, time: 1790000000 })
            else if (!(saved.count > 0)) Object.assign(saved, { count: 1, time: 1790000000 })
        }
        for (const key of ['pendingTaskStorySync', 'pendingTaskScene', 'pendingCharacterTask'])
            if (past.has(s[key]?.task_id)) delete s[key]
    })
    const party = group(state()),
        controlSlot = party.heros.find((slot) => slot.hero_id === party.control)
    if (!controlSlot.pet_id || controlSlot.pet_id === '0') {
        const owned = state().pets.find(
            (p) =>
                !p.work_status &&
                tables.find('pet', p.config_id) &&
                tables.find('unit', tables.find('pet', p.config_id).unitId),
        )
        assert(owned, 'Explicit fixture party needs a current owned model-backed pet')
        assert(!run(), 'Do not change a restored dungeon party merely to manufacture a pet source')
        call('QuickChangeGroupInfo', {
            type: 1,
            id: party.id,
            infos: party.heros
                .filter((slot) => slot.hero_id && slot.hero_id !== '0')
                .map((slot) => ({
                    hero_guid: slot.hero_id,
                    pet_guid: slot.hero_id === party.control ? owned.guid : (slot.pet_id ?? '0'),
                })),
        })
    }
    const refreshObservers = () => {
        // ActivityGet is retired. This real current empty-receipt query is
        // unrelated to material credit but runs the normal observer boundary.
        assert.equal(state().mall?.popupQueue?.length ?? 0, 0, 'Fixture must not have pending paid deliveries')
        assert.equal(state().mall?.pendingPopup ?? null, null, 'Do not clear an existing receipt to fit the test')
        const assets = () => {
            const s = state()
            return {
                bag: s.player.sbag_infos,
                currencies: s.player.attr_infos,
                heroes: s.player.heros_info,
                souls: s.player.soulessence_infos,
                ornaments: s.ornaments,
                pets: s.pets,
                vehicles: s.vehicles,
                buildings: s.home.inventory,
                clothes: s.unlockedClothes,
                heroSkins: s.unlockedHeroSkins,
            }
        }
        const before = assets(),
            packets = call('GetRechargePopupData'),
            entry = protocol.byName.get('CSProtoGetRechargePopupData'),
            popup = protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
        assert.equal(popup.popup_id ?? 0, 0)
        for (const key of ['mall_data', 'non_mall_data', 'battlepass_data', 'recharge_diamond', 'monthly_card_data'])
            assert.equal(popup[key], undefined, 'An observer refresh must not grant or display rewards')
        assert.deepEqual(assets(), before)
        return packets
    }
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
        // Current BattleService06000694 uses synchronized Unix milliseconds.
        // A later collector report can be in the same server second; advance
        // this client clock without reading/forging a server activation barrier.
        const clockMs = BigInt(Math.floor(now * 1000))
        reportTimeMs = clockMs > reportTimeMs ? clockMs : reportTimeMs + 1n
        const data = read((s) => ({
            hero: pet ? group(s).heros.find((slot) => slot.hero_id === group(s).control).pet_id : group(s).control,
            enemies: Object.values(combatEntityStates(s.combat))
                .filter((e) => enemyDefinition(tables, s, e.uuid)?.object_id === id && e.hp > 0)
                .map((e) => ({ uuid: e.uuid, hp: e.hp })),
        }))
        return call('BattleInfoReduce', {
            uint64_dic: [data.hero, ...data.enemies.map((e) => e.uuid)],
            battle_info: data.enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: damage ?? -e.hp },
            })),
            base_time: reportTimeMs.toString(),
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
        refreshObservers,
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
