import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroModules } from '../src/battle.js'

test('6020 transfers a single ornament by table slot, clears both old owners and publishes attributes before ACK', () => {
    const f = ornamentFixture('single-ornament')
    try {
        const [a, b] = f.state().player.heros_info.heros
        const item = f.state().ornaments[0],
            replacement = f.state().ornaments.at(-1)
        const slot = f.tables.find('accessory', item.id).type - 1
        const wear = (hero, guid) => f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: guid })
        wear(a, item.guid)
        wear(b, replacement.guid)
        const packets = wear(b, item.guid)
        const data = f.state(),
            heroes = data.player.heros_info.heros
        assert.equal(packets.at(-1).id, 6020)
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === 6029))
        assert.ok(
            packets.slice(0, -1).some((packet) => packet.id === f.protocol.byName.get('CSProtoSyncPlayerData').id),
        )
        assert.equal(heroes.find((row) => row.guid === a.guid).oguid[slot], 0)
        assert.equal(heroes.find((row) => row.guid === b.guid).oguid[slot], item.guid)
        assert.equal(data.ornaments.find((row) => row.guid === item.guid).wear_hero, b.guid)
        assert.equal(data.ornaments.find((row) => row.guid === replacement.guid).wear_hero, '0')
        const attrs = heroModules(
            f.tables,
            data,
            heroes.find((row) => row.guid === b.guid),
        ).modules.find((row) => row.module_type === 2)
        assert.ok(attrs.sub_modules[0].attrs.attrs.length)
        wear(b, item.guid)
        assert.equal(f.state().ornaments.find((row) => row.guid === item.guid).wear_hero, b.guid)
        f.reload()
        assert.equal(f.state().player.heros_info.heros.find((row) => row.guid === b.guid).oguid[slot], item.guid)
        const before = structuredClone(f.state())
        assert.throws(
            () => wear(a, 0xffffffff),
            (error) => error.code === ErrorCode.OrnamentNotExist,
        )
        assert.throws(
            () => wear({ guid: '99999999' }, item.guid),
            (error) => error.code === ErrorCode.HeroNotExist,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
