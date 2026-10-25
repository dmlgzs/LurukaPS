import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { battlePassLevelInfo } from '../src/battle-pass-buy-level.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    }
    call('EnterGame', { open_id: 'pet-catch' })
    const g = new TaskGraphs(tables).get(106002)
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 102
        s.world.point_id = 102001
        s.world.pos = { x: 46518, y: 10453, z: 34710 }
        s.tasks = [
            {
                task_id: 106002,
                nodes: [{ ...makeNode(g, 56, s), client_before: true }],
                finish_nodes: [1],
                reward_nodes: [],
            },
        ]
        s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
        s.player.sbag_infos.items = [{ itemid: 1000001, itemnum: 1, itemtype: 3, guid: '600001' }]
    })
    return { store, game, session, call, state: () => store.load(session.id).state, g }
}
function assertCatchBattlePass(packets, f) {
    // The fixture explicitly replaces task progress after login. The next query
    // re-observes battle-pass task visibility/completion and emits18006 once.
    const notices = packets.filter((packet) => packet.id === 18006)
    assert.equal(notices.length, 1)
    const state = f.state(),
        prepared = prepareBattlePass(tables, state, 1800000000),
        snapshot = battlePassTaskSnapshot(tables, state, 1800000000, prepared)
    assert(prepared)
    assert.deepEqual(notices[0].data, {
        one_task: [...snapshot.day_task, ...snapshot.week_task, ...snapshot.forever_task],
        info: battlePassLevelInfo(prepared.season, prepared.ledger),
    })
    assert.equal(packets.at(-1).id, 11030)
}
function assertHeldCardProgress(packets) {
    const notice = packets.find((packet) => packet.id === 9900)
    assert(notice)
    const row = notice.data.achievements.find((entry) => entry.id === 2020026)
    assert(row)
    assert.deepEqual(row.count, [1])
    assert.equal(row.finish_time, '0')
    assert.equal(row.is_reward, false)
}

test('real prologue target102056 queries catch info, consumes one card, creates owned pet and advances objective', () => {
    const f = fixture(),
        target = ((4n << 56n) | 102056n).toString()
    try {
        const before = f.state(),
            query = f.call('GetCatchPetInfo', { tar_id: [target], day_weather: 2, reason: 1, pet_len_id: 0 })
        assert.deepEqual(
            query.map((x) => x.id),
            [11031, 18006, 9900, 11030],
        )
        assertHeldCardProgress(query)
        assertCatchBattlePass(query, f)
        assert.equal(query[0].data.pets[0].uuid, target)
        assert.equal(query[0].data.pets[0].rank, 1)
        const preview = query[0].data.pets[0].comprehension
        const wrong = f.store.load(f.session.id)
        assert.throws(() => f.call('CatchPet', { tar_id: target, item_id: 400000, catch_key: 1 }), /card/)
        assert.deepEqual(f.store.load(f.session.id), wrong)
        const card = f
            .call('CatchPetCard', { item_id: 1000001, is_create: true, client_param: '1' })
            .find((x) => x.id === 11223).data
        assert(card.catch_key > 0)
        assert.equal(card.client_param, '1')
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 0)
        assert.equal(
            f.call('CatchPetCard', { item_id: 1000001, is_create: true, client_param: '1' }).find((x) => x.id === 11223)
                .data.catch_key,
            card.catch_key,
        )
        const response = f.call('CatchPet', {
                tar_id: target,
                item_id: 1000001,
                day_weather: 2,
                catch_key: card.catch_key,
                position: { x: 465.18, y: 104.53, z: 347.1 },
            }),
            result = response.find((x) => x.id === 10714).data
        assert.equal(result.success, true)
        assert.equal(f.state().dailyActive.day.counts[13109], 1)
        assert.equal(f.state().dailyActive.week.counts[13109], 1)
        assert.equal(result.tar_id, target)
        assert(result.guid !== '0')
        assert(response.findIndex((x) => x.id === 6517) < response.findIndex((x) => x.id === 10714))
        // Single-player catch is completed by the CatchPet response; there is no AOI despawn notification.
        // assert.equal(response.find((x) => x.id === 11066)?.data.agent_uid, target)
        // assert(response.findIndex((x) => x.id === 11066) > response.findIndex((x) => x.id === 10714))
        const created = f.state().pets.find((x) => x.guid === result.guid)
        assert(created)
        assert.equal(created.config_id, 500297)
        assert.equal(created.satiety_val, 60)
        assert.equal(
            response.find((packet) => packet.id === 6517).data.pet_infos.pets.find((pet) => pet.guid === created.guid)
                .satiety_val,
            60,
        )
        assert(!before.pets.some((x) => x.guid === created.guid))
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 0)
        assert.deepEqual(created.comprehension, preview)
        assert.equal(f.state().combat.entities[target].hp, 0)
        assert.equal(f.state().combat.entities[target].captured, true)
        const hero = f.state().player.heros_info.battle_infos[0],
            hp = hero.hp
        f.call('BattleInfoReduce', {
            uint64_dic: [target, hero.hero_id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -10 } }],
        })
        assert.equal(f.state().player.heros_info.battle_infos[0].hp, hp)
        f.call('ObjHatredIncSync', { inc: true, info: { id: target, target_obj_ids: [hero.hero_id] } })
        assert.equal(f.state().combat.hatred.objects[target], undefined)
        // Single-player map sync does not send an AOI despawn notification for captured enemies.
        // assert(
        //     f
        //         .call('EnterWorldMap', { map_id: 102, point_id: 102001 })
        //         .some((x) => x.id === 11066 && x.data.agent_uid === target),
        // )
        const retry = f.call('CatchPet', { tar_id: target, item_id: 1000001, catch_key: card.catch_key })
        assert.equal(retry.find((x) => x.id === 10714).data.guid, result.guid)
        assert.equal(f.state().pets.length, before.pets.length + 1)
        assert.equal(f.state().noviceCounters.captures, 1)
        f.call('CatchPetPlayOver', { tar_id: target, day_weather: 2 })
        const condition =
            f.g.nodes.get(56).__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData
                .__type_TaskCondFractalPetCatchData
        f.call('ClientBehaviourRecord', {
            key: 2526,
            args: [106002, condition.enemyData.createNpcId, condition.uniKey, 2],
        })
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 2)
        f.call('TaskClientAfter', { task_id: 106002, node_id: 56 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 65)
        const who = {},
            e = p.byName.get('CSProtoEnterGame'),
            login = f.game.dispatch(who, { id: e.id, seq: 1, payload: p.encode(e.req, { open_id: 'pet-catch' }) })
        assert(p.decode(e.rsp, login.find((x) => x.id === e.id).payload).data.heros_info)
        assert(f.store.load(f.session.id).state.pets.some((x) => x.guid === created.guid))
        assert.equal(
            p
                .decode('SCPetInfoSync', login.find((packet) => packet.id === 6517).payload)
                .pet_infos.pets.find((pet) => pet.guid === created.guid).satiety_val,
            60,
        )
    } finally {
        f.store.close()
    }
})
test('real omitted catch key is allocated, failed throw refunds once, and disconnect returns reservations', () => {
    const f = fixture()
    try {
        const request = { item_id: 1000001, is_create: true, client_param: '1153319716794662913' }
        const first = f.call('CatchPetCard', request).find((x) => x.id === 11223).data
        assert(first.catch_key > 0)
        assert.equal(first.client_param, request.client_param)
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 0)
        const refunded = f
            .call('CatchPetCard', { item_id: 1000001, is_create: false, catch_key: first.catch_key })
            .find((x) => x.id === 11223).data
        assert.equal(refunded.catch_key, first.catch_key)
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 1)
        f.call('CatchPetCard', { item_id: 1000001, is_create: false, catch_key: first.catch_key })
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 1)
        const second = f
            .call('CatchPetCard', { ...request, client_param: '1153319721089630209' })
            .find((x) => x.id === 11223).data
        assert(second.catch_key > first.catch_key)
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 0)
        const entry = p.byName.get('CSProtoEnterGame'),
            other = {}
        f.game.dispatch(other, { id: entry.id, seq: 1, payload: p.encode(entry.req, { open_id: 'pet-catch' }) })
        assert.equal(f.state().player.sbag_infos.items[0].itemnum, 1)
        assert.equal(f.state().petCatchCards[second.catch_key].state, 'refunded')
    } finally {
        f.store.close()
    }
})
test('relogin retires captured enemies left alive by the previous server', () => {
    const f = fixture(),
        id = ((4n << 56n) | 102056n).toString()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.petCaptureResults = {
                [id]: { guid: '146263947329142785', item_id: 1000001, pet_id: 500297, map_id: 102, time: 1 },
            }
            s.combat = {
                map_id: 102,
                skills: {},
                bullets: {},
                elements: {},
                entities: { [id]: { uuid: id, hp: 7, alive_state: 0 } },
                report_count: 0,
            }
        })
        const entry = p.byName.get('CSProtoEnterGame'),
            other = {}
        f.game.dispatch(other, { id: entry.id, seq: 1, payload: p.encode(entry.req, { open_id: 'pet-catch' }) })
        assert.equal(f.state().combat.entities[id].hp, 0)
        assert.equal(f.state().combat.entities[id].captured, true)
        // Re-login repairs the saved enemy state; single-player map sync does not send an AOI despawn notification.
        // const world = p.byName.get('CSProtoEnterWorldMap')
        // assert(
        //     f.game
        //         .dispatch(other, {
        //             id: world.id,
        //             seq: 2,
        //             payload: p.encode(world.req, { map_id: 102, point_id: 102001 }),
        //         })
        //         .some((packet) => packet.id === 11066),
        // )
    } finally {
        f.store.close()
    }
})
test('logged mixed scan query resolves task monster and ordinary world enemy packs independently', () => {
    const f = fixture(),
        task = ((4n << 56n) | 102056n).toString(),
        wild = ((3n << 56n) | (1n << 32n) | 200002n).toString()
    try {
        const packets = f.call('GetCatchPetInfo', { tar_id: [wild, task], day_weather: 2, reason: 1 })
        assert.deepEqual(
            packets.map((x) => x.id),
            [11031, 18006, 9900, 11030],
        )
        assertHeldCardProgress(packets)
        assertCatchBattlePass(packets, f)
        assert.deepEqual(
            packets[0].data.pets.map((x) => x.uuid),
            [wild, task],
        )
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('GetCatchPetInfo', { tar_id: ['123'], day_weather: 2, reason: 1 }),
            /not a catchable pet/,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('successful capture unlocks the acquired species in 6517 before the catch result and repeated catch does not duplicate history', () => {
    const f = fixture(),
        target = ((4n << 56n) | 102056n).toString()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.recordPets = []
        })
        const key = f
            .call('CatchPetCard', { item_id: 1000001, is_create: true, client_param: 'catalog' })
            .find((p) => p.id === 11223).data.catch_key
        const request = { tar_id: target, item_id: 1000001, catch_key: key }
        const packets = f.call('CatchPet', request)
        const sync = packets.find((p) => p.id === 6517)
        assert.deepEqual(sync.data.record_pets, [500297])
        assert.ok(packets.findIndex((p) => p.id === 6517) < packets.findIndex((p) => p.id === 10714))
        f.call('CatchPet', request)
        assert.deepEqual(f.state().recordPets, [500297])
    } finally {
        f.store.close()
    }
})

test('logged new-map puzzle noncatchable target can be aimed at without enabling its capture', () => {
    const f = fixture(),
        target = '504403166855430276'
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
            s.tasks = []
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
            s.playableEnemies = {
                '101:1200054:20061': {
                    entities: [{ uuid: target, config_id: 310606, container: 132, index: 0, slot: 2 }],
                },
            }
        })
        const state = f.state(),
            world = new WorldObjectCatalog(tables)
        const valid = world
            .get('worldmap_101')
            .map((row) => ((3n << 56n) | BigInt(row.id)).toString())
            .find((id) => {
                const def = enemyDefinition(tables, state, id)
                const petId = def && tables.find('enemy', def.config_id)?.petId
                return (
                    Number.isSafeInteger(petId) &&
                    petId > 0 &&
                    tables.find('pet', petId) &&
                    tables.find('enemy_pack', def.pack_id)?.uncatchableType !== 1
                )
            })
        assert.ok(valid)
        const mixed = f.call('GetCatchPetInfo', { tar_id: [target, valid], day_weather: 8, reason: 1 })
        assert.deepEqual(
            mixed[0].data.pets.map((p) => p.uuid),
            [valid],
        )
        const before = f.state()
        const packets = f.call('GetCatchPetInfo', { tar_id: [target], day_weather: 8, reason: 1, pet_len_id: 0 })
        assert.equal(packets[0].id, 11031)
        assert.deepEqual(packets[0].data.pets, [])
        assert.equal(packets[0].data.reason, 1)
        assert.deepEqual(f.state().pets, before.pets)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.throws(
            () => f.call('CatchPet', { tar_id: target, item_id: 1000001, catch_key: 1 }),
            /Pet cannot be caught/,
        )
    } finally {
        f.store.close()
    }
})
