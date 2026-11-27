import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { repairHeroAccessorySlots, HERO_ACCESSORY_SLOT_COUNT } from '../src/hero-accessory-slots.js'
import { ErrorCode } from '../src/error-codes.js'

test('current hero login/reward data provides all five indexed accessory slots and repairs missing lists without completing guides', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, value) => {
            const entry = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
        },
        login = () => call('EnterGame', { open_id: 'current-accessory-slot-shape' }),
        playerData = (packets) => {
            const entry = protocol.byName.get('CSProtoEnterGame'),
                packet = packets.find((p) => p.id === entry.id)
            return protocol.decode(entry.rsp, packet.payload).data
        },
        checkClientSlots = (hero) => {
            // Model the recovered native List.get_Item(slot-1),not a UI
            // default that would hide the current out-of-range failure.
            for (let slot = 1; slot <= 5; slot++) {
                if (!hero.oguid || slot - 1 >= hero.oguid.length) throw RangeError('client accessory slot index')
            }
        }
    try {
        const first = playerData(login())
        for (const hero of first.heros_info.heros) checkClientSlots(hero)
        store.transact(session.id, 0, (state) =>
            grantRewards(tables, state, [{ itemtype: 1, itemid: 108001, itemnum: 1 }]),
        )
        const granted = store.load(session.id).state.player.heros_info.heros.find((hero) => hero.conf_id === 108001)
        assert.equal(
            granted.oguid.length,
            HERO_ACCESSORY_SLOT_COUNT,
            'Task/gacha/GM shared factory must produce the complete empty list',
        )
        const guide = [{ id: 30023, sub_id: 3002301, complete: true }]
        store.transact(session.id, 0, (state) => {
            for (const hero of state.player.heros_info.heros) delete hero.oguid
            state.player.guide_infos = { infos: structuredClone(guide) }
        })
        const before = store.load(session.id).state,
            assets = {
                heroes: before.player.heros_info.heros.map((hero) => hero.guid),
                bag: structuredClone(before.player.sbag_infos),
                pets: before.pets.map((pet) => pet.guid),
            }
        session = {}
        const restored = playerData(login()),
            after = store.load(session.id).state
        for (const hero of restored.heros_info.heros) checkClientSlots(hero)
        assert(after.player.heros_info.heros.every((hero) => hero.oguid.length === 5))
        assert.deepEqual(after.player.guide_infos.infos, guide, 'Do not skip,complete or erase the real pending guide')
        assert.deepEqual(
            after.player.heros_info.heros.map((hero) => hero.guid),
            assets.heroes,
        )
        assert.deepEqual(after.player.sbag_infos, assets.bag)
        assert.deepEqual(
            after.pets.map((pet) => pet.guid),
            assets.pets,
        )
        const sample = structuredClone(after),
            hero = sample.player.heros_info.heros[0]
        hero.oguid = [123456]
        repairHeroAccessorySlots(tables, sample)
        const wire = protocol.decode('cs.HeroItemInfo', protocol.encode('cs.HeroItemInfo', hero))
        assert.equal(wire.oguid[0], 123456, 'Padding must not replace an existing uint32 accessory binding')
        assert.equal(wire.oguid.length, 5)
        const malformed = structuredClone(after)
        delete malformed.player.heros_info.heros[0].oguid
        malformed.player.heros_info.heros[1].oguid = 'damaged'
        const prior = structuredClone(malformed)
        assert.throws(
            () => repairHeroAccessorySlots(tables, malformed),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(malformed, prior)
    } finally {
        store.close()
    }
})
