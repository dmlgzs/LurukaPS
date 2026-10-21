import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroModules } from '../src/battle.js'

test('6027 removes one configured slot or all five including locked pieces, clears stats and persists without deleting inventory', () => {
    const f = ornamentFixture('ornament-remove')
    try {
        const hero = f.state().player.heros_info.heros[0]
        const selected = f.state().ornaments.slice(0, 5)
        for (const item of selected) f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: item.guid })
        f.call('SetLockOrnament', { guid: selected[0].guid, lock: true })
        const count = f.state().ornaments.length,
            before = structuredClone(f.state())
        const type = f.tables.find('accessory', selected[0].id).type
        const packets = f.call('RemoveOrnament', { hero_id: hero.guid, type })
        assert.equal(packets.at(-1).id, 6027)
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === 6029))
        const now = f.state().player.heros_info.heros.find((row) => row.guid === hero.guid)
        assert.equal(now.oguid[type - 1], 0)
        for (let slot = 0; slot < 5; slot++)
            if (slot !== type - 1)
                assert.equal(
                    now.oguid[slot],
                    before.player.heros_info.heros.find((row) => row.guid === hero.guid).oguid[slot],
                )
        const removed = f.state().ornaments.find((row) => row.guid === selected[0].guid)
        assert.equal(removed.wear_hero, '0')
        assert.equal(removed.lock, true)
        f.call('RemoveOrnament', { hero_id: hero.guid, type: 0, remove_all: true })
        f.reload()
        const data = f.state(),
            saved = data.player.heros_info.heros.find((row) => row.guid === hero.guid)
        assert.deepEqual(saved.oguid, [0, 0, 0, 0, 0])
        assert.equal(data.ornaments.length, count)
        assert.ok(selected.every((item) => data.ornaments.find((row) => row.guid === item.guid).wear_hero === '0'))
        const module = heroModules(f.tables, data, saved).modules.find((row) => row.module_type === 2)
        assert.deepEqual(module.sub_modules[0].attrs.attrs, [])
        assert.deepEqual(module.sub_modules[0].skills.skills, [])
        f.call('RemoveOrnament', { hero_id: hero.guid, remove_all: true })
        const stable = structuredClone(f.state())
        assert.throws(
            () => f.call('RemoveOrnament', { hero_id: hero.guid, type: 0 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), stable)
    } finally {
        f.store.close()
    }
})
