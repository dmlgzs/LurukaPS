import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, heroData } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('switching to another slot updates metadata before ACK; mount/dismount preserves it without a party reload or movement', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'mount-control' })
        let target, mount
        store.transact(session.id, 0, (s) => {
            const hero = s.player.heros_info.heros.find((h) => h.conf_id === 101010) ?? heroData(101010, session.id)
            if (!s.player.heros_info.heros.includes(hero)) s.player.heros_info.heros.push(hero)
            target = hero.guid
            const m = s.player.group_mgrs.find((m) => m.type === 1),
                g = m.groups.find((g) => g.id === m.cur_group)
            g.heros[1] = { hero_id: target, pet_id: '0' }
            const [r] = grantRewards(tables, s, [{ itemtype: 5, itemid: 500022, itemnum: 1 }])
            mount = r.guid
        })
        const before = store.load(session.id).state.world
        const switched = call('SwitchWorldGroupControl', { type: 1, control: target })
        const sync = switched.find((p) => protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData')
        assert.ok(switched.indexOf(sync) < switched.findIndex((p) => p.id === 5983))
        assert.equal(sync.data.group_mgrs[0].src, 1)
        assert.equal(sync.data.group_mgrs[0].groups[0].control, target)
        const mounted = call('WorldMapPlayerStatus', { status: 1, arg: mount })
        const cached = mounted.find((p) => protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData')
        // The delta cache can omit unchanged metadata already sent by the switch.
        if (cached) {
            assert.ok(
                mounted.indexOf(cached) <
                    mounted.findIndex((p) => protocol.byId.get(p.id).name === 'CSProtoWorldMapPlayerStatus'),
            )
            assert.equal(cached.data.group_mgrs[0].src, 1)
            assert.equal(cached.data.group_mgrs[0].groups[0].control, target)
        }
        assert.ok(mounted.filter((p) => p.id === 9103).every((p) => p.data.map_info.players[0].group === undefined))
        call('WorldMapPlayerStatus', { status: 0, arg: '0' })
        const state = store.load(session.id).state,
            m = state.player.group_mgrs.find((m) => m.type === 1)
        assert.equal(m.groups.find((g) => g.id === m.cur_group).control, target)
        assert.deepEqual(state.world.pos, before.pos)
    } finally {
        store.close()
    }
})

test('mount entry repairs a server-side control change that the client cache never received', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'mount-stale-control' })
        let target, mount
        store.transact(session.id, 0, (s) => {
            const h = heroData(101010, session.id)
            target = h.guid
            if (!s.player.heros_info.heros.some((x) => x.guid === target)) s.player.heros_info.heros.push(h)
            const m = s.player.group_mgrs.find((m) => m.type === 1),
                g = m.groups.find((g) => g.id === m.cur_group)
            g.heros[1] = { hero_id: target, pet_id: '0' }
            g.control = target
            mount = grantRewards(tables, s, [{ itemtype: 5, itemid: 500022, itemnum: 1 }])[0].guid
        })
        const packets = call('WorldMapPlayerStatus', { status: 1, arg: mount })
        const data = packets.find((p) => protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData')
        assert.ok(data)
        assert.equal(data.data.group_mgrs[0].src, 1)
        assert.equal(data.data.group_mgrs[0].groups[0].control, target)
        assert.ok(
            packets.indexOf(data) <
                packets.findIndex((p) => protocol.byId.get(p.id).name === 'CSProtoWorldMapPlayerStatus'),
        )
    } finally {
        store.close()
    }
})
