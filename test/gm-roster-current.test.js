import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-gm-roster-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ configuration }, { Tables, seedPlayer }, { Protocol }, { Store }, { Game }, catalogue, { ErrorCode }, points] =
    await Promise.all([
        import('../src/config.js'),
        import('../src/player.js'),
        import('../src/protocol.js'),
        import('../src/store.js'),
        import('../src/game.js'),
        import('../src/gm-roster-catalogue.js'),
        import('../src/error-codes.js'),
        import('../src/gm-world-points.js'),
    ])
const text = (value) => Buffer.from(String(value)).toString('base64')
const command = (name, args = []) => ({ command: text(name), args: args.map(text) })

function fixture(name, options = {}) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    // Private fresh ownership baseline, prepared before the first SQL insert.
    // This is not a migration or a proposal for the production starter factory.
    store.login(name, (id, openId) => {
        const state = seedPlayer(tables, id, openId),
            main = state.player.heros_info.heros.find((hero) => hero.type === 1)
        assert(main)
        main.hero_lv = 3
        state.player.heros_info.heros = [main]
        state.player.heros_info.battle_infos = []
        for (const manager of state.player.group_mgrs)
            for (const group of manager.groups) {
                group.heros = group.heros.map((slot, index) => ({
                    hero_id: index === 0 ? main.guid : '0',
                    pet_id: '0',
                }))
                group.control = main.guid
            }
        const pet = state.pets.find((pet) => pet.config_id === 500001)
        assert(pet)
        pet.lv = 3
        state.pets = [pet]
        state.petBoxes = state.petBoxes.filter((box) => box.id === Math.floor(pet.box_id / 100))
        state.petProvenance.entries = { [pet.guid]: state.petProvenance.entries[pet.guid] }
        return state
    })
    const game = new Game(protocol, store, tables, {
        clock: () => 1800000000,
        arenaClockMs: () => 1800000000000,
        rng: () => 0,
        ...options,
    })
    let seq = 1,
        session = {}
    const frame = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) }
    }
    const dispatch = (frame) => {
        const packets = game.dispatch(session, frame)
        for (const packet of packets) {
            const entry = protocol.byId.get(packet.id)
            assert(entry)
            protocol.decode(entry.rsp, packet.payload)
        }
        return packets
    }
    const call = (name, data = {}) => dispatch(frame(name, data))
    const state = () => store.load(session.id).state
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const raw = () => ({
        players: store.db.prepare('SELECT * FROM players ORDER BY account_id').all(),
        logs: store.db.prepare('SELECT * FROM request_log ORDER BY id').all(),
        seq: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        sqliteSeq: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
    })
    const owned = () => ({
        heroes: state().player.heros_info.heros,
        pets: state().pets,
        records: state().recordPets,
        counts: state().heroAcquisitionCounts,
        allocation: state().petGuidAllocation,
        provenance: state().petProvenance,
    })
    return {
        tables,
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        state,
        login,
        raw,
        owned,
        id: () => session.id,
        close: () => store.close(),
    }
}

test('current GM catalogue selects exact usable definitions, excludes missing model/stats, and plans without mutation', () => {
    const f = fixture('gm-roster-catalogue')
    try {
        const before = f.state(),
            c = catalogue.gmRosterCatalogue(f.tables)
        assert.equal(c.heroes.length, 23)
        assert.equal(c.excludedHeroes.length, 0)
        assert.equal(c.pets.length, 237)
        assert.equal(c.excludedPets.length, 21)
        assert(c.pets.includes(500061) && c.pets.includes(500062))
        assert.equal(catalogue.gmHeroRewards(f.tables, before).length, 22)
        assert.equal(catalogue.gmPetRewards(f.tables, before).length, 236)
        assert.deepEqual(f.state(), before)
        const noModel = new Tables(configuration().tables)
        const hero = noModel.find('hero', c.heroes[0])
        noModel.cache.set(
            'unit',
            noModel.get('unit').map((row) => (row.id === hero.unitId ? { ...row, model: '' } : row)),
        )
        const filtered = catalogue.gmRosterCatalogue(noModel)
        assert(!filtered.heroes.includes(hero.id))
        assert(filtered.excludedHeroes.some((row) => row.id === hero.id && row.reason === 'missing-primary-model'))
        const bad = new Tables(configuration().tables)
        bad.cache.set(
            'template_value',
            bad.get('template_value').map((row) => (row.id === 500001 ? { ...row, baseAttribute: '' } : row)),
        )
        assert.throws(
            () => catalogue.gmRosterCatalogue(bad),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('giveallheroes/allheroes grant permanent current heroes once with real attributes, preserving existing upgrades and relogin', () => {
    const f = fixture('gm-roster-heroes')
    try {
        const original = f.state().player.heros_info.heros[0],
            request = f.frame('GMCommand', command('giveallheroes'))
        const packets = f.dispatch(request),
            owned = f.owned(),
            heroes = f.state().player.heros_info.heros
        assert.equal(heroes.length, 23)
        assert.deepEqual(
            heroes.find((hero) => hero.guid === original.guid),
            original,
        )
        assert(heroes.every((hero) => !hero.trail && !hero.abyss && BigInt(hero.guid) >> 56n === 1n))
        const attr = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
        const metadata = f.protocol.byName.get('CSProtoSyncPlayerData')
        const attrIndex = packets.findIndex((packet) => packet.id === attr.id)
        const metadataIndex = packets.findIndex(
            (packet) =>
                packet.id === metadata.id &&
                f.protocol.decode(metadata.rsp, packet.payload).heros_info?.heros?.length === 23,
        )
        assert(attrIndex >= 0 && metadataIndex > attrIndex)
        assert(
            f.protocol.decode(attr.rsp, packets[attrIndex].payload).heros.filter((hero) => hero.type === 1).length ===
                23,
        )
        f.dispatch(request)
        f.call('GMCommand', command('allheroes'))
        assert.deepEqual(f.owned(), owned)
        f.login()
        f.call('GMCommand', command('giveallheroes'))
        // Current HeroItemInfo.dorm_id is optional uint32 (default zero).
        // Login syncDormResidents writes that zero for unassigned heroes;
        // retain every nonzero residence and compare all other owned fields.
        const dormDefaults = (value) => ({
            ...value,
            heroes: value.heroes.map((hero) => ({ dorm_id: 0, ...hero })),
        })
        assert.deepEqual(dormDefaults(f.owned()), dormDefaults(owned))
    } finally {
        f.close()
    }
})

test('giveallpets/allpets grant one of each exact permanent config through allocator and acquisition sync, replay and relogin do not duplicate', () => {
    const f = fixture('gm-roster-pets')
    try {
        const original = f.state().pets[0],
            originalBoxes = f.state().petBoxes,
            request = f.frame('GMCommand', command('giveallpets'))
        assert.equal(originalBoxes.length, 1, 'private minimal inventory starts with one real box')
        const packets = f.dispatch(request),
            state = f.state(),
            owned = f.owned(),
            expected = catalogue.gmRosterCatalogue(f.tables).pets
        assert.deepEqual(
            [...new Set(state.pets.map((pet) => pet.config_id))].sort((a, b) => a - b),
            expected,
        )
        assert.equal(state.pets.length, 237)
        assert.equal(state.petBoxes.length, 8, 'central allocation lazily creates only the eight necessary boxes')
        for (const box of originalBoxes)
            assert.deepEqual(
                state.petBoxes.find((row) => row.id === box.id),
                box,
            )
        assert(state.pets.every((pet) => pet.box_id >= 101 && pet.box_id <= 830))
        assert.deepEqual(
            state.pets.find((pet) => pet.guid === original.guid),
            original,
        )
        assert.equal(new Set(state.pets.map((pet) => pet.guid)).size, state.pets.length)
        assert(
            state.pets.every(
                (pet) =>
                    pet.type === 1 &&
                    BigInt(pet.guid) >> 56n === 2n &&
                    Number(BigInt(pet.guid) & 0xffffffffn) === f.id(),
            ),
        )
        assert.equal(state.recordPets.length, 236, 'already owned starter is not newly acquired by a no-op grant')
        const sync = f.protocol.byName.get('CSProtoPetInfoSync'),
            index = packets.findIndex((packet) => packet.id === sync.id)
        assert(index >= 0)
        assert.equal(f.protocol.decode(sync.rsp, packets[index].payload).pet_infos.pets.length, 237)
        f.dispatch(request)
        f.call('GMCommand', command('allpets'))
        assert.deepEqual(f.owned(), owned)
        f.login()
        f.call('GMCommand', command('giveallpets'))
        assert.deepEqual(f.owned(), owned)
    } finally {
        f.close()
    }
})

test('GM enabled, zero-argument grammar, unlocked capacity and whole command batch remain atomic', () => {
    const disabled = fixture('gm-roster-disabled', { gmEnabled: false })
    try {
        for (const name of ['giveallheroes', 'allheroes', 'giveallpets', 'allpets']) {
            const before = disabled.state()
            assert.throws(() => disabled.call('GMCommand', command(name)), /disabled/)
            assert.deepEqual(disabled.state(), before)
        }
    } finally {
        disabled.close()
    }
    const f = fixture('gm-roster-atomic')
    try {
        for (const name of ['giveallheroes', 'giveallpets']) {
            const before = f.state()
            assert.throws(
                () => f.call('GMCommand', command(name, ['extra'])),
                (error) => Number.isInteger(error.code),
            )
            assert.deepEqual(f.state(), before)
        }
        const before = f.state(),
            sql = f.raw()
        assert.throws(
            () =>
                f.call('GMCommands', {
                    cmds: [command('gold 1'), command('giveallheroes'), command('giveallpets'), command('unknown')],
                }),
            /Unknown GM/,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.raw(), sql)
        f.store.transact(f.id(), 0, (state) => {
            state.lockedPetBoxes = Array.from({ length: 19 }, (_, i) => i + 2)
        })
        const full = f.state()
        assert.throws(
            () => f.call('GMCommand', command('giveallpets')),
            (error) => error.code === ErrorCode.BagPetFullForAdd,
        )
        assert.deepEqual(f.state(), full)
    } finally {
        f.close()
    }
})

test('unlockpoints/allpoints union only current activatable points while unlockmaps retains its legacy flag and all commands preserve assets', () => {
    const f = fixture('gm-world-points-current-wire')
    try {
        const current = points.currentGmWorldPoints(f.tables)
        assert.equal(current.pointIds.length, 26)
        const legacy = f.tables
            .get('world_borthpos')
            .find((row) => !current.pointIds.includes(row.id) && row.id !== 10101).id
        f.store.transact(f.id(), 0, (state) => {
            state.world.points = [legacy]
            delete state.world.unlockAllMaps
        })
        const assets = f.owned(),
            worldObjects = f.state().worldObjects,
            records = f.state().taskRecords
        const balance = [
            f.state().player.basic_info.gold,
            f.state().player.basic_info.diamond,
            f.state().player.attr_infos,
        ]
        const expected = [...current.pointIds, legacy].sort((a, b) => a - b)
        const first = f.call('GMCommand', command('unlockpoints'))
        assert.deepEqual(f.state().world.points, expected)
        assert.equal(f.state().world.unlockAllMaps, undefined)
        const pointSync = f.protocol.byName.get('CSProtoWorldMapPointSync')
        const taskSync = f.protocol.byName.get('CSProtoTaskSync')
        const index = first.findIndex((packet) => packet.id === pointSync.id)
        assert(index >= 0 && first.findIndex((packet) => packet.id === taskSync.id) < index)
        assert.deepEqual(f.protocol.decode(pointSync.rsp, first[index].payload).u32s, expected)
        assert(index < first.findIndex((packet) => packet.id === 19903))
        assert(!f.state().world.points.includes(10101), 'cross-scene entrance is not automatically activated')
        f.call('GMCommand', command('allpoints'))
        assert.deepEqual(f.state().world.points, expected)
        assert.equal(f.state().world.unlockAllMaps, undefined)
        f.call('GMCommand', command('unlockmaps'))
        assert.equal(f.state().world.unlockAllMaps, true)
        assert.deepEqual(f.state().world.points, expected)
        f.call('GMCommand', command('unlockmaps'))
        assert.deepEqual(f.state().world.points, expected)
        assert.deepEqual(f.owned(), assets)
        assert.deepEqual(f.state().worldObjects, worldObjects)
        assert.deepEqual(f.state().taskRecords, records)
        assert.deepEqual(
            [f.state().player.basic_info.gold, f.state().player.basic_info.diamond, f.state().player.attr_infos],
            balance,
        )
        f.login()
        assert.equal(f.state().world.unlockAllMaps, true)
        assert.deepEqual(f.state().world.points, expected)
    } finally {
        f.close()
    }
})

for (const [commandName, syncName] of [
    ['giveallheroes', 'CSProtoSyncPlayerData'],
    ['giveallpets', 'CSProtoPetInfoSync'],
])
    test(
        commandName +
            ' actual outgoing encoder failure restores SQL, pending identity, allocation and ownership before retry',
        () => {
            const f = fixture('gm-roster-codec-' + commandName)
            try {
                f.store.transact(
                    f.id(),
                    0,
                    (state) => {
                        state.player.basic_info.gold += 1
                    },
                    { defer: true },
                )
                const request = f.frame('GMCommand', command(commandName)),
                    before = f.state(),
                    sql = f.raw()
                const retained = f.store.pending.get(f.id()),
                    retainedState = structuredClone(retained.state)
                const original = f.protocol.encode,
                    target = f.protocol.byName.get(syncName).rsp
                let calls = 0
                f.protocol.encode = function (type, value) {
                    if (type === target) {
                        calls++
                        throw Error('gm-roster-codec')
                    }
                    return original.call(this, type, value)
                }
                try {
                    assert.throws(() => f.dispatch(request), /gm-roster-codec/)
                } finally {
                    f.protocol.encode = original
                }
                assert.equal(calls, 1)
                assert.deepEqual(f.state(), before)
                assert.deepEqual(f.raw(), sql)
                assert.equal(f.store.pending.get(f.id()), retained)
                assert.deepEqual(retained.state, retainedState)
                f.dispatch(request)
                const owned = f.owned()
                f.dispatch(request)
                assert.deepEqual(f.owned(), owned)
            } finally {
                f.close()
            }
        },
    )
