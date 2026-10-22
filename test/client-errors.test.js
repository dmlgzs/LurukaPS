import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 12345, pushSeq: 0, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'logged-errors' })
    return { store, game, session, call, state: () => store.load(session.id).state }
}
test('logged pause/world-time/loaded/control messages persist actual client state', () => {
    const f = fixture()
    try {
        const value = { game_time: '9007199254740993', operate: true }
        assert.deepEqual(f.call('GamePause', value)[0].data, value)
        assert.equal(f.state().world.pause.operate, true)
        f.call('GamePause', { game_time: '9007199254741000', operate: false })
        assert.equal(f.state().world.pause.operate, false)
        f.call('WorldTimeSync', { world_time: 123456 })
        assert.equal(f.state().world.world_time, 123456)
        assert.deepEqual(f.call('MultiCampaignPlayerLoaded'), [])
        assert.equal(f.state().world.client_loaded, true)
        const g = f.state().player.group_mgrs[0].groups[0]
        assert.deepEqual(f.call('SwitchGroupControlEnd', { uuid: g.control }), [])
        assert.equal(f.state().world.control_ready, g.control)
        assert.throws(() => f.call('SwitchGroupControlEnd', { uuid: '123' }))
    } finally {
        f.store.close()
    }
})
test('quick formation updates slots, control and simultaneous pet swaps before reply', () => {
    const f = fixture()
    try {
        const s = f.state(),
            [a, b] = s.player.heros_info.heros,
            [p, q] = s.pets
        f.call('WearPet', { hero_guid: a.guid, pet_guid: p.guid })
        f.call('WearPet', { hero_guid: b.guid, pet_guid: q.guid })
        const packets = f.call('QuickChangeGroupInfo', {
            type: 1,
            id: 1,
            infos: [
                { hero_guid: b.guid, pet_guid: p.guid },
                { hero_guid: '0', pet_guid: '0' },
                { hero_guid: a.guid, pet_guid: q.guid },
            ],
        })
        const now = f.state(),
            g = now.player.group_mgrs[0].groups[0]
        assert.deepEqual(
            g.heros.map((x) => x.hero_id),
            [b.guid, '0', a.guid],
        )
        assert.deepEqual(
            g.heros.map((x) => x.pet_id),
            [p.guid, '0', q.guid],
        )
        assert.equal(now.player.heros_info.heros.find((h) => h.guid === a.guid).pet_id, q.guid)
        assert.equal(now.pets.find((x) => x.guid === p.guid).hero_id, b.guid)
        assert.equal(now.pets.find((x) => x.guid === q.guid).hero_id, a.guid)
        assert.equal(packets.at(-1).id, 5981)
        assert(packets.slice(0, -1).some((p) => p.id === 10009))
        const before = f.store.load(f.session.id)
        for (const infos of [
            [
                { hero_guid: a.guid, pet_guid: p.guid },
                { hero_guid: b.guid, pet_guid: p.guid },
            ],
            [{ hero_guid: a.guid }, { hero_guid: a.guid }],
            [{ hero_guid: '0', pet_guid: p.guid }],
            [{ hero_guid: a.guid, pet_guid: '999' }],
        ]) {
            assert.throws(() => f.call('QuickChangeGroupInfo', { type: 1, id: 1, infos }))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.store.close()
    }
})
test('legacy two-pet formation is visible on login and a full save preserves both pets', () => {
    const f = fixture()
    try {
        const [a, b] = f.state().player.heros_info.heros,
            [p, q] = f.state().pets
        f.store.transact(f.session.id, 0, (s) => {
            const heroes = s.player.heros_info.heros,
                pets = s.pets,
                group = s.player.group_mgrs[0].groups[0]
            heroes[0].pet_id = p.guid
            heroes[1].pet_id = q.guid
            pets[0].hero_id = a.guid
            pets[1].hero_id = b.guid
            group.heros = [{ hero_id: a.guid }, { hero_id: b.guid }, { hero_id: '0' }]
            group.control = a.guid
            s.initialFormationVersion = 2
        })
        const session = {},
            entry = protocol.byName.get('CSProtoEnterGame'),
            packets = f.game.dispatch(session, {
                id: entry.id,
                seq: 1,
                payload: protocol.encode(entry.req, { open_id: 'logged-errors' }),
            })
        const wire = protocol.decode('SCEnterGame', packets.find((x) => x.id === 5001).payload).data.group_mgrs[0]
            .groups[0]
        assert.deepEqual(
            wire.heros.map((x) => x.pet_id),
            [p.guid, q.guid, '0'],
        )
        assert.deepEqual(
            f.state().player.group_mgrs[0].groups[0].heros.map((x) => x.pet_id),
            [p.guid, q.guid, '0'],
        )
        f.call('QuickChangeGroupInfo', {
            type: 1,
            id: 1,
            infos: [
                { hero_guid: a.guid, pet_guid: p.guid },
                { hero_guid: b.guid, pet_guid: q.guid },
                { hero_guid: '0', pet_guid: '0' },
            ],
        })
        assert.deepEqual(
            f.state().player.group_mgrs[0].groups[0].heros.map((x) => x.pet_id),
            [p.guid, q.guid, '0'],
        )
        assert.equal(f.state().player.heros_info.heros.find((h) => h.guid === a.guid).pet_id, p.guid)
        assert.equal(f.state().player.heros_info.heros.find((h) => h.guid === b.guid).pet_id, q.guid)
    } finally {
        f.store.close()
    }
})
test('equipping and reordering heroes keeps every normal formation pet slot in sync', () => {
    const f = fixture()
    try {
        const [a, b] = f.state().player.heros_info.heros,
            [p, q] = f.state().pets
        f.store.transact(f.session.id, 0, (s) => {
            const group = s.player.group_mgrs[0].groups[0]
            group.heros = [
                { hero_id: a.guid, pet_id: '0' },
                { hero_id: b.guid, pet_id: '0' },
                { hero_id: '0', pet_id: '0' },
            ]
            group.control = a.guid
            s.initialFormationVersion = 2
        })
        f.call('WearPet', { hero_guid: a.guid, pet_guid: p.guid })
        const packets = f.call('WearPet', { hero_guid: b.guid, pet_guid: q.guid })
        assert.deepEqual(
            f.state().player.group_mgrs[0].groups[0].heros.map((x) => x.pet_id),
            [p.guid, q.guid, '0'],
        )
        const heroSync = packets.findIndex((x) => x.id === 5008 && x.data.heros_info?.heros?.length),
            groupSync = packets.findIndex((x) => x.id === 5008 && x.data.group_mgrs?.length)
        assert(heroSync >= 0 && groupSync > heroSync)
        assert.deepEqual(
            packets[groupSync].data.group_mgrs[0].groups[0].heros.map((x) => x.pet_id),
            [p.guid, q.guid, '0'],
        )
        f.call('ChangeHeroGroupIndex', {
            type: 1,
            group: { id: 1, heros: [{ hero_id: b.guid }, { hero_id: a.guid }, { hero_id: '0' }], control: b.guid },
        })
        assert.deepEqual(
            f.state().player.group_mgrs[0].groups[0].heros.map((x) => x.pet_id),
            [q.guid, p.guid, '0'],
        )
    } finally {
        f.store.close()
    }
})
test('logged state queries return stored lists and bounded telemetry without fake one-way replies', () => {
    const f = fixture()
    try {
        assert.deepEqual(f.call('ChatGetIsolateList')[0].data, { isolates: [], lists: [] })
        assert.deepEqual(f.call('TitleGetList')[0].data, { preffix_title: [171000], suffix_title: [172000] })
        f.store.transact(f.session.id, 0, (s) => {
            s.chatIsolation = { isolates: [2], lists: [] }
            s.titles = { preffix_title: [171002], suffix_title: [172002] }
        })
        assert.deepEqual(f.call('ChatGetIsolateList')[0].data.isolates, [2])
        assert.deepEqual(f.call('TitleGetList')[0].data.suffix_title, [172000, 172002])
        for (let i = 0; i < 35; i++) f.call('ClientBehaviourRecord', { key: i, args: [i, 1] })
        assert.equal(f.state().clientBehaviour.length, 32)
        assert.equal(f.state().clientBehaviour[0].key, 3)
        const packets = f.call('GetMaxArealine', { area_id: 100001 })
        assert.equal(packets.length, 1)
        assert.equal(packets[0].id, 9144)
        assert.deepEqual(packets[0].data, { area_id: 100001, max_arealine: 1 })
    } finally {
        f.store.close()
    }
})
