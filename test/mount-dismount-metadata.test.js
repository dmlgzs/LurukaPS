import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { worldSync } from '../src/handlers/world.js'

test('mount identity transitions through zero over repeated same-pet cycles and switching pets', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        p = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'mount-cycle-regression' })
        let first, second
        store.transact(session.id, 0, (state) => {
            first = grantRewards(tables, state, [{ itemtype: 5, itemid: 500022, itemnum: 1 }])[0].guid
            second = grantRewards(tables, state, [{ itemtype: 5, itemid: 500820, itemnum: 1 }])[0].guid
            state.world.map_id = 101
            state.world.lastMountMetadata = { map_id: 101, guid: first }
        })
        let clientId = '0',
            changes = 0
        const consume = (packets, id, status) => {
            const updates = packets.filter((x) => x.id === 9103).map((x) => p.decode('WorldMapNotify', x.payload))
            assert.ok(updates.length)
            for (const update of updates) {
                const player = update.map_info.players[0]
                assert.equal(player.mount, id)
                assert.equal(player.status, status)
                assert.equal(player.group, undefined)
                if (clientId !== player.mount) changes++
                clientId = player.mount
            }
        }
        const position = structuredClone(store.load(session.id).state.world.pos)
        for (const id of [first, first, first, second, first]) {
            const before = changes
            consume(call('WorldMapPlayerStatus', { status: 1, arg: id }), id, 1)
            assert.equal(changes, before + 1, 'each remount emits a fresh mount-ID change for the client')
            call('WorldMapPlayerPlayerAction', { action: 3 })
            consume(call('WorldMapPlayerStatus', { status: 0, arg: '0' }), '0', 0)
            const state = store.load(session.id).state
            assert.equal(state.world.mount, '0')
            assert.equal(state.world.status, 0)
            assert.equal(state.world.lastMountMetadata, undefined)
            assert.equal(state.mountRideId, id)
            assert.deepEqual(state.world.pos, position)
            const exited = structuredClone(state)
            assert(call('WorldMapPlayerPlayerAction', { action: 3 }).some((packet) => packet.id === 9120))
            assert.deepEqual(store.load(session.id).state, exited)
            const snapshots = []
            worldSync(
                {
                    state,
                    tables,
                    id: session.id,
                    now: 1800000000,
                    push: (name, data) => snapshots.push({ name, data }),
                },
                {},
                47,
                false,
            )
            assert.equal(snapshots.find((x) => x.name === 'CSProtoWorldMapSync').data.map_info.players[0].mount, '0')
        }
        store.transact(session.id, 0, (state) => {
            state.world.lastMountMetadata = { map_id: 101, guid: first }
        })
        const login = p.byName.get('CSProtoEnterGame')
        const relog = game.dispatch(
            {},
            {
                id: login.id,
                seq: 1,
                payload: p.encode(login.req, { open_id: 'mount-cycle-regression', reconnect: true }),
            },
        )
        assert.equal(store.load(session.id).state.world.lastMountMetadata, undefined)
        assert.ok(
            relog
                .filter((x) => x.id === 9103)
                .every((x) =>
                    p.decode('WorldMapNotify', x.payload).map_info.players.every((player) => player.mount === '0'),
                ),
        )
    } finally {
        store.close()
    }
})
