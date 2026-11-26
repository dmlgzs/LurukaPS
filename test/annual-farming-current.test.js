import assert from 'node:assert/strict'
import test from 'node:test'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { gridAnchor } from '../src/home-grid.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { parseRewards } from '../src/rewards.js'
test('normal current public farm producers preserve sealed rewards, charge seeds, complete manual/worker Journey goals and roll back harvest failures', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => now,
        rng: (min, max) => (max === undefined ? min - 1 : max - 1),
        gmEnabled: true,
    })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e, 'current public protocol: ' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    const gm = (s) => call('GMCommand', { command: Buffer.from(s).toString('base64') })
    const reply = (packets, id) => protocol.decode(protocol.byId.get(id).rsp, packets.find((p) => p.id === id).payload)
    const report = {
        qualification: 'explicit trusted post106010 save only; not full story progression E2E',
        checks: [],
    }
    try {
        call('EnterGame', { open_id: 'annual-public-current' })
        report.normal = {
            pets: state().pets.length,
            items: state().player.sbag_infos.items.length,
            souls: state().player.soulessence_infos.soulessences.length,
        }
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = [{ task_id: 106010, count: 1 }]
        })
        gm('level 30')
        call('EnterHome', { creator_id: session.id })
        const field = reply(
            call('FieldOpen', { field_type: 1, locate: { block_id: 102, anchor: gridAnchor(-50, 10), direction: 0 } }),
            6113,
        )
        gm('give 10 103 1000')
        call('ShopBuyItems', { shop_id: 200001, items: [{ slot_id: 2010104, goods_id: 2010104, times: 1 }] })
        const crop = () => state().home.builds.find((b) => b.guid === field.guid).crop_info
        call('FieldPlant', { plant_info: [{ build_guid: field.guid, seed_id: 310901 }] })
        assert.equal(crop().seed_id, 31)
        assert.equal(crop().state, 1)
        call('FieldWater', { build_guid: field.guid })
        call('WaterFinish', { build_guid: field.guid })
        assert.equal(crop().state, 2)
        const immature = store.load(session.id)
        assert.throws(() => call('FieldHarvest', { build_guid: field.guid }), /not ready/)
        assert.deepEqual(store.load(session.id), immature)
        const sealed = structuredClone(state().home.cropOutcomes[field.guid])
        session = {}
        call('EnterGame', { open_id: 'annual-public-current' })
        call('EnterHome', { creator_id: session.id })
        assert.deepEqual(state().home.cropOutcomes[field.guid], sealed)
        now = crop().state_finish_time + crop().pre_cost_time
        const ready = store.load(session.id),
            encode = protocol.encode,
            harvestRsp = protocol.byName.get('CSProtoFieldHarvest').rsp
        protocol.encode = function (name, value) {
            if (name === harvestRsp) throw Error('annual-harvest-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => call('FieldHarvest', { build_guid: field.guid }), /annual-harvest-codec/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(store.load(session.id), ready)
        store.db.exec(
            "CREATE TRIGGER annual_harvest_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'annual-harvest-sql'); END",
        )
        try {
            assert.throws(() => call('FieldHarvest', { build_guid: field.guid }), /annual-harvest-sql/)
        } finally {
            store.db.exec('DROP TRIGGER annual_harvest_abort')
        }
        assert.deepEqual(store.load(session.id), ready)
        const harvest = reply(
            call('FieldHarvest', { build_guid: field.guid }),
            protocol.byName.get('CSProtoFieldHarvest').id,
        )
        assert(harvest.reward.rewards.length > 0)
        assert.deepEqual(
            harvest.reward.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            sealed.rewards,
        )
        assert(!crop().seed_id)
        const model = journeyModel(tables),
            goals = model.targets.filter((r) => r.tokens[0] === 12062)
        report.checks.push({
            source: 'actual FieldOpen1/ShopBuy2010104/FieldPlant/FieldWater/WaterFinish/FieldHarvest',
            reward: harvest.reward.rewards,
            goals: goals.map((r) => ({
                id: r.id,
                value: journeyValue(tables, state(), r),
                complete: state().journey.targets[r.id]?.complete,
            })),
        })
        gm('give 13 20171 1')
        const house = reply(
            call('BuildLocate', {
                build_id: 20171,
                locate: { block_id: 101, anchor: gridAnchor(-50, -20), direction: 0 },
            }),
            6105,
        )
        const species = tables
            .get('pet_home_talent')
            .find((p) => String(p.laborType).split('|').includes('5') && tables.find('pet', p.id))
        gm(`give 5 ${species.id} 1`)
        const worker = state().pets.find((p) => p.config_id === species.id)
        assert(worker && worker.labor_infos.some((r) => r.labor_id === 5 && r.labor_grade > 0))
        call('ChoseAutoWorkPet', { build_guid: house.guid, work_type: 1003, pet_guid: worker.guid })
        call('ShopBuyItems', { shop_id: 200001, items: [{ slot_id: 2010302, goods_id: 2010302, times: 1 }] })
        call('FieldPlant', { plant_info: [{ build_guid: field.guid, seed_id: 310902 }] })
        call('FieldWater', { build_guid: field.guid })
        call('WaterFinish', { build_guid: field.guid })
        now = crop().state_finish_time + crop().pre_cost_time
        call('FieldHarvest', { build_guid: field.guid, is_pet: true })
        const beforeClaim = goals.map((r) => ({
            id: r.id,
            value: journeyValue(tables, state(), r),
            complete: state().journey.targets[r.id]?.complete,
        }))
        call('GetAutoWorkCropReward', { u32: house.guid })
        report.checks.push({
            source: 'actual GM-owned current house+worker/BuildLocate/ChoseAutoWorkPet/ShopBuy2010302/worker harvest/storage claim',
            worker: worker.guid,
            species: species.id,
            beforeClaim,
            afterClaim: goals.map((r) => ({
                id: r.id,
                value: journeyValue(tables, state(), r),
                complete: state().journey.targets[r.id]?.complete,
            })),
        })
        assert(goals.every((r) => state().journey.targets[r.id]?.complete))
        const claimed = structuredClone(state().home.farmHarvestProgress)
        session = {}
        call('EnterGame', { open_id: 'annual-public-current' })
        call('EnterHome', { creator_id: session.id })
        assert.deepEqual(state().home.farmHarvestProgress, claimed)
        const count = (id) =>
            state()
                .player.sbag_infos.items.filter((r) => r.itemid === id)
                .reduce((n, r) => n + r.itemnum, 0)
        const seedStock = count(310901)
        call('FieldPlant', { plant_info: [{ build_guid: field.guid, seed_id: 310901 }] })
        assert.equal(count(310901), seedStock - 1)
        const removal = reply(call('FieldUnplant', { u32: field.guid }), protocol.byName.get('CSProtoFieldUnplant').id)
        const expectedRemoval = parseRewards(tables.find('home_seeds', 31).cancelWithdraw)
        assert.deepEqual(removal.rewards, expectedRemoval)
        assert.equal(
            count(310901),
            seedStock - 1 + expectedRemoval.filter((r) => r.itemid === 310901).reduce((n, r) => n + r.itemnum, 0),
        )
        assert(!crop().seed_id)
        call('FieldClose', { field_id: field.guid })
        assert(!state().home.builds.some((b) => b.guid === field.guid))
        assert.deepEqual(state().home.farmHarvestProgress, claimed)
        report.checks.push({
            source: 'immature rejection/cold enter/6117 codec+SQL rollback/retry/6118 refund/6114 close',
            sealedPersisted: true,
            codecAndSQLAtomic: true,
            fieldRemoved: true,
            acquiredGoalsPreserved: true,
        })
        console.log(JSON.stringify(report, null, 2))
    } finally {
        store.close()
    }
})
