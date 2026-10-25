import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { accessoryProductionPlan } from '../src/accessory-production.js'

export function forgeFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    game.rng = () => 0
    const call = (name, request = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.player.basic_info.lv = 45
        if (!s.home.builds.some((b) => b.guid === 200))
            s.home.builds.push({
                guid: 200,
                build_id: 20241,
                build_type: 8,
                status: 1,
                locate: { block_id: 101, anchor: 6750239, direction: 0 },
            })
        s.materialDungeonRecords = Object.fromEntries(
            tables.get('dungeon_material').map((row) => [
                row.id,
                {
                    material_id: row.id,
                    material_star: 0,
                    success_count: 1,
                    difficulty_id: row.diff,
                    success_time: String(now),
                },
            ]),
        )
    })
    const plan = (id, directed = true, count = 1) => {
        const build = state().home.builds.find((b) => b.guid === 200)
        const random = accessoryProductionPlan(tables, state(), build, { product_id: id, count })
        const target = directed ? [...random.leaves.keys()][0] : 0
        return accessoryProductionPlan(tables, state(), build, { product_id: id, count, designated_item_id: target })
    }
    const start = (id, directed = true, count = 1) => {
        const p = plan(id, directed, count)
        edit((s) =>
            grantRewards(
                tables,
                s,
                p.costs.map((row) => ({ ...row, itemnum: row.itemnum * count })),
            ),
        )
        const before = new Set((state().home.productionJobs?.[200] ?? []).map((j) => j.guid))
        const packets = call('ProductOrnamentStart', {
            build_guid: 200,
            product_id: id,
            count,
            designated_item_id: p.target,
        })
        return { packets, jobs: state().home.productionJobs[200].filter((j) => !before.has(j.guid)), plan: p }
    }
    const finish = (jobs, mode = 'finish') =>
        mode === 'aggregate'
            ? call('GetAllBuildReward', { build_guid: [200] })
            : call(mode === 'cancel' ? 'ProductCancel' : 'ProductFinish', {
                  guid: 200,
                  product_guids: jobs.map((j) => j.guid),
              })
    const due = (jobs) => {
        now = Math.max(now, ...jobs.map((j) => j.start + j.count * j.seconds))
    }
    const make = (id, directed = true, count = 1, mode = 'finish') => {
        const accepted = start(id, directed, count)
        due(accepted.jobs)
        return finish(accepted.jobs, mode)
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        edit,
        state,
        plan,
        start,
        finish,
        due,
        make,
        advance(n) {
            now += n
        },
        reload() {
            session = {}
            return call('EnterGame', { open_id: name })
        },
    }
}
