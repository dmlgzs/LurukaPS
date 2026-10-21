import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ensureHome } from '../src/home.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { accessoryProductionPlan, accessoryProductionChoices } from '../src/accessory-production.js'
import { ErrorCode } from '../src/error-codes.js'
import { getEntrustCatalog } from '../src/entrust.js'
const stock = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
const wallet = (s, id) => BigInt(s.player.attr_infos.attrs.find((x) => x.attr_id === id)?.attr_val ?? 0)
function fixture(name, unlocked = true) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    game.rng = () => 0
    store.transact(session.id, 0, (s) => {
        const home = ensureHome(tables, s)
        home.builds.push({
            guid: 20,
            build_id: 20241,
            build_type: 8,
            status: 1,
            locate: { block_id: 101, anchor: 6750239, direction: 0 },
        })
        s.player.basic_info.lv = 45
        if (unlocked)
            s.materialDungeonRecords = Object.fromEntries(
                tables
                    .get('dungeon_material')
                    .map((row) => [row.id, { material_id: row.id, material_star: 0, success_count: 1 }]),
            )
        const needed = new Map()
        for (const row of tables.get('accessory_product'))
            for (const item of [...parseRewards(row.material), ...parseRewards(row.locateCost)])
                needed.set(item.itemtype + ':' + item.itemid, { ...item, itemnum: 10000 })
        grantRewards(tables, s, [...needed.values()])
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        advance: (n) => (now += n),
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}
const request = { build_guid: 20, product_id: 1, count: 1 }
const response = (f, packets, id) =>
    f.protocol.decode(f.protocol.byId.get(id).rsp, packets.find((p) => p.id === id).payload)

test('all17 current recipes and every designated leaf plan from linked data without changing the player', () => {
    const f = fixture('accessory-production-catalog')
    try {
        const s = f.state(),
            b = s.home.builds.find((x) => x.guid === 20),
            saved = structuredClone(s)
        let targets = 0
        for (const row of f.tables.get('accessory_product')) {
            const plan = accessoryProductionPlan(f.tables, s, b, { ...request, product_id: row.id })
            assert.equal(plan.seconds, row.time * 60)
            assert.deepEqual(plan.costs, parseRewards(row.material))
            for (const id of plan.leaves.keys()) {
                const selected = accessoryProductionPlan(f.tables, s, b, {
                    ...request,
                    product_id: row.id,
                    designated_item_id: id,
                })
                assert.equal(selected.target, id)
                assert.deepEqual(selected.locateCosts, parseRewards(row.locateCost))
                targets++
            }
        }
        assert.equal(f.tables.get('accessory_product').length, 17)
        assert(targets > 70)
        assert.deepEqual(s, saved)
        const choices = accessoryProductionChoices(f.tables, 660001)
        for (const [draw, id] of [
            [0, 50017],
            [2999, 50017],
            [3000, 50018],
            [5999, 50018],
            [6000, 50019],
            [7000, 50020],
            [8000, 50016],
            [9999, 50016],
        ]) {
            const values = [0, 0, draw, 0]
            assert.equal(
                choices.drops.drops(660001, (max) => {
                    const n = values.shift()
                    assert(n >= 0 && n < max)
                    return n
                })[0].itemid,
                id,
            )
        }
    } finally {
        f.store.close()
    }
})

test('10202 consumes a batch once, uses independent queue slots and refunds actual unfinished costs', () => {
    const f = fixture('accessory-production-batch')
    try {
        const before = structuredClone(f.state())
        f.call('ProductOrnamentStart', { ...request, count: 3 })
        let s = f.state(),
            jobs = s.home.productionJobs[20]
        assert.equal(jobs.length, 3)
        assert(jobs.every((x) => x.count === 1 && x.kind === 'accessory' && x.seconds === 60))
        assert.deepEqual(
            jobs.map((x) => x.start),
            [1800000000, 1800000060, 1800000120],
        )
        assert.equal(stock(s, 353016), stock(before, 353016) - 30)
        assert.equal(stock(s, 313001), stock(before, 313001) - 15)
        assert.equal(wallet(s, 705), wallet(before, 705) - 150n)
        const saved = structuredClone(s)
        assert.throws(
            () => f.call('ProductOrnamentStart', { ...request, count: 2 }),
            (e) => e.code === ErrorCode.ProductQueueFull,
        )
        assert.deepEqual(f.state(), saved)
        assert.throws(() => f.call('ProductFinish', { guid: 20, is_all: true }))
        f.advance(60)
        f.game.tick(f.session.id)
        const claimed = f.call('ProductFinish', { guid: 20, product_guids: [jobs[0].guid] })
        const ack = f.protocol.byName.get('CSProtoProductFinish').id,
            reply = response(f, claimed, ack)
        assert.equal(reply.reward.src, 37)
        assert.equal(reply.reward.rewards[0].itemtype, 15)
        assert.equal(reply.reward.rewards[0].itemid, f.tables.find('accessory_customed', 50017).accessoryId)
        assert(claimed.findIndex((x) => x.id === 6029) < claimed.findIndex((x) => x.id === ack))
        assert.equal(f.state().ornaments.length, 1)
        const canceled = f.call('ProductCancel', { guid: 20, is_all: true })
        assert.equal(response(f, canceled, f.protocol.byName.get('CSProtoProductCancel').id).reward.src, 38)
        s = f.state()
        assert.equal(stock(s, 353016), stock(before, 353016) - 10)
        assert.equal(stock(s, 313001), stock(before, 313001) - 5)
        assert.equal(wallet(s, 705), wallet(before, 705) - 50n)
        assert.equal(s.home.builds.find((x) => x.guid === 20).specials.length, 0)
        assert.equal(s.home.craftCounts[1], 1)
        assert.throws(() => f.call('ProductFinish', { guid: 20, is_all: true }))
        assert.throws(() => f.call('ProductCancel', { guid: 20, product_guids: [jobs[1].guid] }))
    } finally {
        f.store.close()
    }
})

test('designated crafting publishes the custom ID and costs, resumes after login and creates unique actual instances', () => {
    const f = fixture('accessory-production-designated')
    try {
        const before = structuredClone(f.state())
        const started = f.call('ProductOrnamentStart', { ...request, count: 2, designated_item_id: 50018 })
        const homePacket = started.find((p) => p.id === f.protocol.byName.get('CSProtoHomeSync').id)
        const homeWire = f.protocol.decode(f.protocol.byName.get('CSProtoHomeSync').rsp, homePacket.payload)
        const special = homeWire.home_builds.find((x) => x.guid === 20).specials
        assert.equal(special.length, 2)
        assert(
            special.every(
                (x) =>
                    x.designate_item_id === 50018 &&
                    x.designate_item_type === 33 &&
                    x.designate_cost[0].itemid === 605111,
            ),
        )
        assert.equal(stock(f.state(), 605111), stock(before, 605111) - 2)
        let b = f.state().home.builds.find((x) => x.guid === 20)
        assert.equal(b.specials.length, 2)
        assert(
            b.specials.every(
                (x) =>
                    x.designate_item_id === 50018 &&
                    x.designate_item_type === 33 &&
                    x.designate_cost[0].itemid === 605111,
            ),
        )
        f.advance(30)
        f.reload()
        b = f.state().home.builds.find((x) => x.guid === 20)
        assert(b.specials.every((x) => x.designate_item_id === 50018))
        f.advance(90)
        f.call('ProductFinish', { guid: 20, is_all: true })
        const items = f.state().ornaments,
            custom = f.tables.find('accessory_customed', 50018)
        assert.equal(items.length, 2)
        assert.equal(new Set(items.map((x) => x.guid)).size, 2)
        assert(items.every((x) => x.id === custom.accessoryId && x.grade === custom.grade && x.quality > 0))
        assert.equal(f.state().home.builds.find((x) => x.guid === 20).specials.length, 0)
        f.store.flushPending()
        assert.equal(JSON.parse(f.store.playerById.get(f.session.id).state).ornaments.length, 2)
    } finally {
        f.store.close()
    }
})

test('technology10093 applies per-unit native rounding and cancellation returns the discounted debit', () => {
    const f = fixture('accessory-production-discount')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.home.technology = { levels: { 10093: { level: 1, lastTime: 0, isOpened: true } }, spent: 0 }
        })
        const before = structuredClone(f.state())
        f.call('ProductOrnamentStart', { ...request, count: 2, designated_item_id: 50017 })
        assert.equal(stock(f.state(), 353016), stock(before, 353016) - 18)
        assert.equal(stock(f.state(), 313001), stock(before, 313001) - 8)
        assert.equal(wallet(f.state(), 705), wallet(before, 705) - 90n)
        assert.equal(stock(f.state(), 605111), stock(before, 605111) - 2)
        f.call('ProductCancel', { guid: 20, is_all: true })
        assert.equal(stock(f.state(), 353016), stock(before, 353016))
        assert.equal(stock(f.state(), 313001), stock(before, 313001))
        assert.equal(wallet(f.state(), 705), wallet(before, 705))
        assert.equal(stock(f.state(), 605111), stock(before, 605111))
    } finally {
        f.store.close()
    }
})

test('invalid recipes, ownership, retained parameters, targets and shortages leave the full state unchanged', () => {
    const f = fixture('accessory-production-invalid')
    try {
        const base = structuredClone(f.state()),
            cases = [
                { r: { ...request, product_id: 0xffffffff }, code: ErrorCode.ProductConfNotExist },
                { r: { ...request, build_guid: 0xffffffff }, code: ErrorCode.HomeNoBuild },
                { r: { ...request, build_guid: 1 }, code: ErrorCode.ProductConfReqGroupNotMatch },
                { r: { ...request, count: 0 }, code: ErrorCode.HomeProductStartContError },
                { r: { ...request, count: 5 }, code: ErrorCode.ProductQueueFull },
                { r: { ...request, ornament_guid: 1 }, code: ErrorCode.ProductSelectMaterialFail },
                { r: { ...request, designated_item_id: 1110111 }, code: ErrorCode.ProductSelectMaterialFail },
                { change: (s) => delete s.materialDungeonRecords[30101], code: ErrorCode.ProductUnlockCondition },
                {
                    change: (s) => (s.home.builds.find((x) => x.guid === 20).status = 0),
                    code: ErrorCode.HomeBuildInvalidStatus,
                },
                {
                    change: (s) => (s.player.attr_infos.attrs.find((x) => x.attr_id === 705).attr_val = '0'),
                    code: ErrorCode.ItemNotEnough,
                },
            ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.change?.(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('ProductOrnamentStart', c.r ?? request),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('a real9510 material clear unlocks10202 without a fabricated completion and the crafted instance arrives on finish', () => {
    const f = fixture('accessory-production-real-clear', false)
    try {
        assert.throws(
            () => f.call('ProductOrnamentStart', request),
            (e) => e.code === ErrorCode.ProductUnlockCondition,
        )
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        f.call('MultiCampaignPlayerLoadFinish')
        const stages = getEntrustCatalog(f.tables).stages(30101),
            marker = stages[0].row.id
        f.call('WorldObjInteract', {
            objs: [{ obj: { obj_id: marker, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        for (const stage of stages.filter((x) => x.type === 50)) {
            const s = f.state(),
                enemies = Object.values(s.combat.entities).filter((x) => x.object_id === stage.row.id)
            f.call('BattleInfoReduce', {
                uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((x) => x.uuid)],
                battle_info: enemies.map((x, i) => ({
                    hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
                })),
                base_time: '0',
            })
        }
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
        f.call('MultiCampaignQuit')
        f.call('ProductOrnamentStart', { ...request, designated_item_id: 50017 })
        f.advance(60)
        f.call('ProductFinish', { guid: 20, is_all: true })
        assert.equal(f.state().ornaments.length, 1)
        assert.equal(f.state().ornaments[0].id, f.tables.find('accessory_customed', 50017).accessoryId)
    } finally {
        f.store.close()
    }
})

test('forging dispatch uses AccessoryTimeReduct and removing the worker retimes work without resetting its progress', () => {
    const f = fixture('accessory-production-worker')
    try {
        let petId
        f.store.transact(f.session.id, 0, (s) => {
            const worker = s.pets[0]
            petId = worker.guid
            Object.assign(worker, {
                labor_infos: [{ labor_id: 11, labor_grade: 20 }],
                talent_id: [],
                satiety_val: 10000,
                work_status: 0,
                work_build: 0,
                hero_id: '0',
            })
            s.world.map_id = Number(f.tables.get('game').find((x) => x.title === 'HOME_ID').value)
        })
        f.call('PetStationed', { build_guid: 20, build_type: 2, pet_guid: petId })
        f.call('ProductOrnamentStart', request)
        let job = f.state().home.productionJobs[20][0]
        assert.equal(job.seconds, 42)
        const originalStart = job.start,
            choice = structuredClone(job.rewards)
        f.advance(10)
        f.call('PetStationed', { build_guid: 20, build_type: 2, pet_guid: '0' })
        job = f.state().home.productionJobs[20][0]
        assert.equal(job.seconds, 60)
        assert(job.start < originalStart)
        assert.deepEqual(job.rewards, choice)
        f.advance(46)
        f.call('ProductFinish', { guid: 20, is_all: true })
        assert.equal(f.state().ornaments.length, 1)
    } finally {
        f.store.close()
    }
})

test('a damaged generation recipe rolls back both a queued start and a finished claim without losing the paid job', () => {
    const f = fixture('accessory-production-bad-custom'),
        custom = f.tables.find('accessory_customed', 50017),
        original = custom.quality
    try {
        custom.quality = '1#0'
        let before = structuredClone(f.state())
        assert.throws(
            () => f.call('ProductOrnamentStart', { ...request, designated_item_id: 50017 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        custom.quality = original
        f.call('ProductOrnamentStart', { ...request, designated_item_id: 50017 })
        f.advance(60)
        custom.quality = '1#0'
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('ProductFinish', { guid: 20, is_all: true }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        custom.quality = original
        f.call('ProductFinish', { guid: 20, is_all: true })
        assert.equal(f.state().ornaments.length, 1)
    } finally {
        custom.quality = original
        f.store.close()
    }
})
