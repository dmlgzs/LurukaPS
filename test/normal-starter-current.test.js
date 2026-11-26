import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-starter-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [
    { createNormalStarterFixture },
    { Tables, seedPlayer },
    { configuration },
    { starterProfileMode },
    { mainHeroConfigId },
] = await Promise.all([
    import('./normal-starter-current-fixture.js'),
    import('../src/player.js'),
    import('../src/config.js'),
    import('../src/starter-profile.js'),
    import('../src/main-hero.js'),
])
console.log('[normal-starter-current-artifacts] ' + artifacts)
const fixture = (name, options = {}) =>
    createNormalStarterFixture(name, { ...options, traceDirectory: path.join(artifacts, 'trace') })
function noPetOwnershipFacts(state) {
    assert.deepEqual(state.pets, [])
    assert.deepEqual(state.recordPets ?? [], [])
    assert.deepEqual(Object.keys(state.petProvenance?.entries ?? {}), [])
    assert.deepEqual(Object.keys(state.petCaptureResults ?? {}), [])
    assert.deepEqual(Object.keys(state.petHandbook ?? {}), [])
    assert.deepEqual(Object.keys(state.petHandbookCasts ?? {}), [])
}

test('normal factory exposes its LOCAL loading avatar and no synthetic pet/item/point ownership or provenance', () => {
    const tables = new Tables(configuration().tables)
    for (const options of [undefined, { mode: 'normal' }]) {
        const state = seedPlayer(tables, 77, 'factory-normal', options)
        assert.equal(starterProfileMode(state), 'normal')
        assert.equal(state.player.heros_info.heros.length, 1)
        assert.equal(state.player.heros_info.heros[0].conf_id, mainHeroConfigId(tables, 2))
        assert.equal(state.player.heros_info.heros[0].type, 1)
        // Explicit LOCAL compatibility values pending their client consumers;
        // these fields never identify normal/sandbox mode.
        assert.equal(state.player.basic_info.is_created, true)
        assert.equal(state.player.basic_info.skip_guide, 0)
        assert.equal(state.player.basic_info.nest_guide_finish, 1)
        assert.equal(state.player.basic_info.gold, 0, 'LOCAL no pre-gift, not official backend initial amount')
        assert.equal(state.player.basic_info.diamond, 0, 'LOCAL no pre-gift, not official backend initial amount')
        noPetOwnershipFacts(state)
        assert.deepEqual(state.petBoxes, [])
        assert.equal(state.petGuidAllocation, undefined)
        assert.equal(state.petProvenance, undefined)
        assert.deepEqual(state.player.soulessence_infos.soulessences, [])
        assert.deepEqual(state.player.sbag_infos.items, [])
        assert.deepEqual(state.world.points, [])
        assert(!state.world.unlockAllMaps)
        assert.deepEqual(Object.keys(state.heroAcquisitionCounts ?? {}), [])
        assert.equal(state.normalStarterAvatar.phase, 'provisional')
        assert.equal(state.normalStarterAvatar.guid, state.player.heros_info.heros[0].guid)
    }
})

test('trusted normal Game enter keeps one female loading avatar and empty acquired pet/point facts without open-id heuristics', () => {
    const f = fixture('sandbox-name-does-not-select-sandbox')
    try {
        const packets = f.login(),
            state = f.state(),
            hero = state.player.heros_info.heros[0]
        assert.equal(starterProfileMode(state), 'normal')
        assert.equal(state.player.heros_info.heros.length, 1)
        assert.equal(hero.conf_id, mainHeroConfigId(f.tables, 2))
        assert.equal(hero.type, 1)
        assert(!state.characterCustomized)
        assert.equal(state.player.basic_info.skip_guide, 0)
        assert.equal(
            state.player.basic_info.nest_guide_finish,
            1,
            'LOCAL compatibility choice, not a normal-mode discriminator',
        )
        assert.equal(f.currentGroup().id, 1)
        assert.equal(f.currentGroup().control, hero.guid)
        assert(
            f
                .currentGroup()
                .heros.slice(1)
                .every((slot) => slot.hero_id === '0' && slot.pet_id === '0'),
        )
        noPetOwnershipFacts(state)
        assert.deepEqual(state.world.points, [])
        assert(!state.world.unlockAllMaps)
        assert.equal(state.player.soulessence_infos.soulessences.length, 0)
        assert(
            (state.tasks ?? []).some((task) => task.task_id === 106001),
            'formal current prologue remains available',
        )
        const attrs = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
        const modules = packets
            .filter((packet) => packet.id === attrs.id)
            .flatMap((packet) => f.protocol.decode(attrs.rsp, packet.payload).heros)
        assert(
            modules.some((row) => row.hero_guid === hero.guid && row.hero_conf_id === hero.conf_id && row.type === 1),
        )
        const stamina = state.player.attr_infos.attrs.find((row) => row.attr_id === 3)
        const declared = f.tables.get('game').find((row) => row.title === 'STAMINA_ACCOUNT_INITAIL').value
        assert.equal(
            stamina.attr_val,
            String(declared),
            'consume current table declaration; do not assume an official backend amount or 200',
        )
        const before = structuredClone(state.player.heros_info.heros)
        f.login()
        assert.deepEqual(f.state().player.heros_info.heros, before)
        noPetOwnershipFacts(f.state())
        assert.deepEqual(f.state().world.points, [])
    } finally {
        f.close()
    }
})

test('existing unversioned legacy account retains owned assets and open points when Game new-account default is normal', () => {
    const f = fixture('legacy-normal-default-preservation', { legacy: true })
    try {
        const old = f.baseline
        f.login()
        const state = f.state()
        assert.equal(starterProfileMode(state), 'legacy')
        assert.equal(state.starterProfile, undefined)
        assert.deepEqual(
            state.player.heros_info.heros.map((row) => row.guid).sort(),
            old.player.heros_info.heros.map((row) => row.guid).sort(),
        )
        assert.deepEqual(state.pets.map((row) => row.guid).sort(), old.pets.map((row) => row.guid).sort())
        assert.deepEqual(
            state.player.soulessence_infos.soulessences.map((row) => row.guid).sort(),
            old.player.soulessence_infos.soulessences.map((row) => row.guid).sort(),
        )
        assert.deepEqual(state.world.points, old.world.points)
        assert.equal(state.world.unlockAllMaps, true)
        assert.equal(state.player.basic_info.skip_guide, old.player.basic_info.skip_guide)
        assert.equal(state.player.basic_info.nest_guide_finish, old.player.basic_info.nest_guide_finish)
    } finally {
        f.close()
    }
})

test('only trusted explicit sandbox Game profile retains the catalogue starter path', () => {
    const f = fixture('normal-name-does-not-select-normal', { starterProfile: 'sandbox' })
    try {
        f.login()
        const state = f.state()
        assert.equal(starterProfileMode(state), 'sandbox')
        assert.equal(
            state.player.heros_info.heros.length,
            f.tables.get('hero').filter((row) => row.isUsable === 1).length,
        )
        assert(state.pets.length > 1)
        assert(state.player.soulessence_infos.soulessences.length > 1)
        assert.deepEqual(
            state.world.points,
            f.tables.get('world_borthpos').map((row) => row.id),
        )
        assert(state.petProvenance && Object.keys(state.petProvenance.entries).length > 1)
    } finally {
        f.close()
    }
})

// Stage2 is intentionally not registered as a passing/todo test. It requires
// the current avatar source and the real prologue callback driver, then will
// use legal 5987 Trial1 + task Before/CondAfter/After + epoch10705 to reach the
// creator checkpoint and send both sexes through actual5010. No fake pending,
// task completion or characterCustomized writes are allowed in that driver.
// Later capture-group49/19 and point10050 tests must be labelled isolated
// checkpoints unless the entire preceding route is actually executed.
