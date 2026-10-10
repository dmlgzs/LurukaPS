import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { optimizeSyncPackets } from '../src/sync-delta.js'
import { retireCapturedEnemy } from '../src/handlers/world-combat.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
const packet = (name, value, meta = {}) => {
    const e = protocol.byName.get(name)
    return { id: e.id, payload: protocol.encode(e.rsp, value), ...meta }
}
const data = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
const optimize = (s, ps, name = 'normal') => optimizeSyncPackets(protocol, s, ps, name)
const pets = () =>
    Array.from({ length: 219 }, (_, i) => ({
        guid: String(144115188075855872n + BigInt(i + 1)),
        config_id: 500001,
        lv: 1,
        pet_name: Buffer.from('pet' + i).toString('base64'),
    }))
test('219-pet snapshots become one changed GUID, delete invalidates the cache and re-add still sends', () => {
    const session = { id: 1 },
        rows = pets(),
        message = () => packet('CSProtoPetInfoSync', { pet_infos: { pets: rows } })
    assert.equal(data(optimize(session, [message()], 'CSProtoEnterGame')[0]).pet_infos.pets.length, 219)
    rows[100].pet_name = Buffer.from('changed').toString('base64')
    const delta = optimize(session, [message()])
    assert.equal(data(delta[0]).pet_infos.pets.length, 1)
    assert.equal(data(delta[0]).pet_infos.pets[0].guid, rows[100].guid)
    assert.ok(delta[0].payload.length < message().payload.length / 50)
    assert.deepEqual(optimize(session, [message()]), [])
    const gone = rows[100]
    const removal = optimize(session, [
        packet('CSProtoPetInfoSync', { pet_infos: { pets: rows.filter((p) => p !== gone), guid: [gone.guid] } }),
    ])
    assert.deepEqual(data(removal[0]).pet_infos.guid, [gone.guid])
    assert.equal(data(optimize(session, [message()])[0]).pet_infos.pets[0].guid, gone.guid)
})
test('player fields, zero currency and one hero update retain their presence semantics', () => {
    const session = { id: 1 },
        value = {
            basic_info: { name: Buffer.from('name').toString('base64'), show_case: 0 },
            attr_infos: {
                attrs: [
                    { attr_id: 1, attr_val: '10' },
                    { attr_id: 2, attr_val: '20' },
                ],
            },
            heros_info: {
                heros: [
                    { guid: '11', conf_id: 107001, hero_lv: 1 },
                    { guid: '12', conf_id: 108001, hero_lv: 1 },
                ],
            },
        }
    optimize(session, [packet('CSProtoSyncPlayerData', value)], 'CSProtoEnterGame')
    value.basic_info.show_case = 1
    value.attr_infos.attrs[0].attr_val = '0'
    value.heros_info.heros[1].hero_lv = 2
    const out = data(optimize(session, [packet('CSProtoSyncPlayerData', value)])[0])
    assert.deepEqual(Object.fromEntries(Object.entries(out.basic_info).filter(([, v]) => !Array.isArray(v))), {
        show_case: 1,
    })
    assert.deepEqual(out.attr_infos.attrs, [{ attr_id: 1, attr_val: '0' }])
    assert.deepEqual(
        out.heros_info.heros.map(({ guid, conf_id, hero_lv }) => ({ guid, conf_id, hero_lv })),
        [{ guid: '12', conf_id: 108001, hero_lv: 2 }],
    )
    value.basic_info.show_case = 0
    assert.equal(data(optimize(session, [packet('CSProtoSyncPlayerData', value)])[0]).basic_info.show_case, 0)
})
test('group deltas keep complete slots and src signals without treating src alone as a state change', () => {
    const session = { id: 1 },
        first = {
            id: 1,
            heros: [
                { hero_id: '11', pet_id: '0' },
                { hero_id: '0', pet_id: '0' },
                { hero_id: '0', pet_id: '0' },
            ],
            control: '11',
        },
        second = { ...first, id: 2, group_name: Buffer.from('second').toString('base64') }
    const manager = { type: 1, cur_group: 1, src: 0, groups: [first, second] }
    optimize(session, [packet('CSProtoSyncPlayerData', { group_mgrs: [manager] })], 'CSProtoEnterGame')
    second.group_name = Buffer.from('renamed').toString('base64')
    const msg = packet('CSProtoSyncPlayerData', { group_mgrs: [{ type: 1, src: 1, groups: [second] }] })
    const out = data(optimize(session, [msg])[0]).group_mgrs[0]
    assert.equal(out.groups.length, 1)
    assert.equal(out.groups[0].id, 2)
    assert.equal(out.groups[0].heros.length, 3)
    assert.equal(out.src, 1)
    assert.deepEqual(optimize(session, [packet('CSProtoSyncPlayerData', { group_mgrs: [manager] })]), [])
    manager.cur_group = 2
    const change = data(optimize(session, [packet('CSProtoSyncPlayerData', { group_mgrs: [manager] })])[0])
        .group_mgrs[0]
    assert.equal(change.cur_group, 2)
    assert.equal(change.groups[0].id, 2)
})
test('building updates/deletes use GUIDs while home-hub guards and other subsystems stay intact', () => {
    const session = { id: 1 },
        house = {
            home_lv: 1,
            home_hub: { station_pets: [] },
            home_builds: [
                { guid: 1, build_id: 110011, build_type: 16 },
                { guid: 2, build_id: 110011, build_type: 16 },
            ],
            shortcut_bars: [{ type: 1, item_id: [1, 0, 0] }],
        }
    optimize(session, [packet('CSProtoHomeSync', house)], 'CSProtoEnterGame')
    house.home_builds[1].build_id = 110012
    const change = data(optimize(session, [packet('CSProtoHomeSync', house)])[0])
    assert.deepEqual(
        change.home_builds.map((b) => b.guid),
        [2],
    )
    assert.deepEqual(change.shortcut_bars[0].item_id, [1, 0, 0])
    house.home_hub.station_pets = ['144115188075855873']
    const hub = data(optimize(session, [packet('CSProtoHomeSync', house)])[0])
    assert.equal(hub.home_builds.length, 1, 'home_hub must pass the client building-list guard')
    assert.deepEqual(hub.home_hub.station_pets, house.home_hub.station_pets)
    const removed = data(
        optimize(session, [
            packet('CSProtoHomeSync', { ...house, home_builds: [house.home_builds[0]], del_builds: [2] }),
        ])[0],
    )
    assert.deepEqual(removed.del_builds, [2])
})
test('sent baseline preserves deferred story task updates and task deletions/readds', () => {
    const session = { id: 1 },
        task = { task_id: 106001, nodes: [{ node_id: 5, node_values: [0] }], client_trace: true },
        snapshot = () => packet('CSProtoTaskSync', { tasks: [task], trace_id: 106001, trace_list: [106001] })
    optimize(session, [snapshot()], 'CSProtoEnterGame')
    task.nodes = [{ node_id: 6, node_values: [0] }]
    optimize(session, [], 'CSProtoTaskClientAfter') // the story barrier withheld the packet
    const after = data(optimize(session, [snapshot()], 'CSProtoSetStoryId')[0])
    assert.equal(after.tasks[0].nodes[0].node_id, 6)
    assert.deepEqual(after.trace_list, [106001])
    const del = data(
        optimize(session, [packet('CSProtoTaskSync', { del_tasks: [106001], del_trace_list: [106001] })])[0],
    )
    assert.deepEqual(del.del_tasks, [106001])
    assert.equal(data(optimize(session, [snapshot()])[0]).tasks[0].task_id, 106001)
})
test('ordinary playable updates change one play and full reset/init remains all_sync', () => {
    const session = { id: 1 },
        plays = [
            { play_id: 60001, status: 1, finish_step: 0 },
            { play_id: 10040, status: 1, finish_step: 0 },
        ]
    optimize(session, [packet('CSProtoPlayableSync', { plays, all_sync: true })], 'CSProtoEnterGame')
    plays[1].finish_step = 1
    const step = data(optimize(session, [packet('CSProtoPlayableSync', { plays, all_sync: false })])[0])
    assert.deepEqual(
        step.plays.map((p) => p.play_id),
        [10040],
    )
    assert.equal(step.all_sync, false)
    const full = optimize(session, [packet('CSProtoPlayableSync', { plays, all_sync: true })])
    assert.equal(data(full[0]).plays.length, 2)
    assert.equal(data(full[0]).all_sync, true)
})
test('packet creation order cannot corrupt deduplication; cache follows physical send order', () => {
    const session = { id: 1 },
        hp = (value) => packet('CSProtoObjBattleInfoSync', { infos: [{ uuid: '11', hp: value }] })
    optimize(session, [hp(10)], 'CSProtoEnterGame')
    const createdFirst = hp(30),
        createdSecond = hp(20)
    assert.deepEqual(
        optimize(session, [createdSecond, createdFirst]).map((p) => data(p).infos[0].hp),
        [20, 30],
    )
    assert.deepEqual(optimize(session, [hp(30)]), [])
    assert.equal(optimize(session, [hp(30)], 'CSProtoBattleInfoReduce').length, 1)
})
test('scene and actor initialization keep mandatory identical packets but inventories retain their baseline', () => {
    const session = { id: 1 },
        list = pets(),
        petPacket = () => packet('CSProtoPetInfoSync', { pet_infos: { pets: list } }),
        info = packet('CSProtoObjBattleInfoSync', { infos: [{ uuid: '11', hp: 100 }] })
    optimize(session, [petPacket(), info], 'CSProtoEnterGame')
    assert.equal(optimize(session, [info], 'CSWorldObjAIHeroInfo').length, 1)
    assert.equal(optimize(session, [packet('CSProtoWorldMapSync', { cmd: 256, map_id: 100 }), info]).length, 2)
    list[0].pet_name = Buffer.from('after scene').toString('base64')
    assert.equal(data(optimize(session, [petPacket()])[0]).pet_infos.pets.length, 1)
    assert.equal(data(optimize(session, [petPacket()], 'CSProtoEnterGame')[0]).pet_infos.pets.length, 219)
})
test('peer packets never seed the owner cache', () => {
    const session = { id: 1 },
        payload = { pet_infos: { pets: pets() } }
    optimize(session, [packet('CSProtoPetInfoSync', payload, { recipient: 2 })])
    assert.equal(data(optimize(session, [packet('CSProtoPetInfoSync', payload)])[0]).pet_infos.pets.length, 219)
})
test('capture clears only actual edges and preserves unrelated enemy relationships', () => {
    const captured = '216172782114383809',
        other = '216172782114383810',
        hero = '72057594037927937'
    const state = {
        world: { map_id: 100 },
        combat: {
            map_id: 100,
            skills: {},
            bullets: {},
            elements: {},
            entities: {},
            hatred: {
                objects: {
                    [captured]: { id: captured, target_obj_ids: [hero], player_obj_ids: [] },
                    [other]: { id: other, target_obj_ids: [captured, hero], player_obj_ids: [] },
                },
                players: { 1: { id: '1', target_obj_ids: [captured, other], player_obj_ids: [] } },
            },
        },
    }
    const pushed = []
    retireCapturedEnemy({ state, now: 1, pushBefore: (name, value) => pushed.push({ name, value }) }, captured)
    assert.ok(pushed.every((p) => ['CSProtoObjHatredIncSync', 'CSProtoPlayerHatredIncSync'].includes(p.name)))
    assert.ok(pushed.every((p) => p.value.inc === false))
    assert.deepEqual(state.combat.hatred.objects[other].target_obj_ids, [hero])
    assert.deepEqual(state.combat.hatred.players['1'].target_obj_ids, [other])
    assert.equal(state.combat.entities[captured].captured, true)
})
test('failed game requests leave the wire baseline unchanged; group rename does not publish all battle attrs', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, value) })
    }
    try {
        call('EnterGame', { open_id: 'sync-cache-rollback' })
        const cache = JSON.stringify([...session.syncCache].map(([k, v]) => [k, [...v]]))
        assert.throws(() => call('PetChangeName', { guid: '0', pet_name: Buffer.from('invalid').toString('base64') }))
        assert.equal(JSON.stringify([...session.syncCache].map(([k, v]) => [k, [...v]])), cache)
        const packets = call('ChangeGroupName', {
            type: 1,
            group_id: 2,
            name: Buffer.from('renamed').toString('base64'),
        })
        assert.ok(
            packets.every(
                (p) => !['CSProtoHeroAttrInfoSync', 'CSProtoObjBattleInfoSync'].includes(protocol.byId.get(p.id).name),
            ),
        )
        const groups = packets.find((p) => protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData')
        assert.equal(data(groups).group_mgrs[0].groups.length, 1)
        assert.equal(data(groups).group_mgrs[0].src, 1)
    } finally {
        store.close()
    }
})
