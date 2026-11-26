import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData, createPets } from '../src/pets.js'
import { repairPetCatalog } from '../src/pet-catalog.js'
import { migratePetGuidIdentity } from '../src/pet-guid-migration.js'
import { permanentPetGuid, parsePetGuid } from '../src/pet-guid.js'
import { petSyncPresentation } from '../src/pet-model-presentation.js'
import { confirmMutation } from '../src/pet-mutation.js'
import {
    mutationProofCatalog,
    mutationGenome,
    mutationBaseHash,
    mutationSlotDomain,
} from '../src/pet-mutation-catalog.js'
import { mutationSourceReceiptKey, findMutationSourceReceipt } from '../src/pet-mutation-state.js'
import { abyssPetGuid, abyssChallengeRoster } from '../src/abyss-roster.js'
import { validateAbyssCheckpoint } from '../src/abyss-resume.js'
import { registerRanch } from '../src/handlers/ranch.js'
import { registerPetMutations } from '../src/handlers/pet-mutation.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const copy = (value) => structuredClone(value)
function legacy(owner = 19) {
    const state = seedPlayer(tables, owner, 'private-guid-migration-fixture')
    delete state.petGuidAllocation
    delete state.petProvenance
    state.pets = [
        petData(tables, 500001, '500001', 101, 1001, () => 0),
        petData(tables, 500002, ((2n << 56n) | (500002n << 32n) | 99n).toString(), 102, 1001, () => 0),
        petData(tables, 500003, permanentPetGuid(owner, 700000), 103, 1001, () => 0),
    ]
    return state
}
const withoutGuid = (pets) => pets.map(({ guid, ...pet }) => pet)
const digest = (text) => createHash('sha256').update(text).digest('hex')
// Explicit saved-state precondition, not an earned new mutation. Generation is
// still gated independently; migration must preserve a legitimate paid proposal.
function storedProposal(state) {
    const pet = state.pets[0],
        catalog = mutationProofCatalog(tables),
        genes = mutationGenome(catalog, pet),
        domain = mutationSlotDomain(catalog, pet, genes, 1)
    assert.equal(domain.innate, true)
    const pending = {
        version: 1,
        kind: 'replace',
        petGuid: pet.guid,
        pos: 1,
        original: copy(genes[0]),
        candidate: { pos: 1, gene_id: domain.candidate, gene_lv: 1 },
        baseHash: mutationBaseHash(pet, genes),
        configFingerprint: catalog.fingerprint,
        counterBefore: 3,
        counterAfter: 2,
        ruleId: catalog.ruleId,
        createdAt: 1800000000,
        generation: '1',
    }
    pet.mutation_times = 2
    pet.mutation_info = { pos: 1, gene_id: domain.candidate }
    state.petMutation = {
        version: 1,
        generationHighWater: '1',
        pets: { [pet.guid]: { version: 1, remainder: 0, pending, lastResolved: null, resolutions: {} } },
        claimResults: {},
    }
}

test('typed current identity migration preserves owned assets, canonical pets, source and unrelated same-value item/config identities', () => {
    const state = legacy(),
        [a, b, canonical] = state.pets.map((pet) => pet.guid),
        hero = state.player.heros_info.heros[0]
    hero.pet_id = a
    state.pets[0].hero_id = hero.guid
    state.player.group_mgrs[0].groups[0].heros[0].pet_id = a
    state.homeFormationBackup = copy(state.player.group_mgrs[0])
    state.player.basic_info.info.pet = [{ guid: a, id: 500001, pos: 1 }]
    state.player.sbag_infos.items = [{ guid: a, itemid: 500001, itemnum: 77, itemtype: 3 }]
    state.home = {
        stationPets: [a],
        builds: [
            {
                guid: 500001,
                station_pet_guid: a,
                auto_info: { plant_pet: a, water_pet: b, harvest_pet: a },
                collect_build_data: { guid: 500001, pet_guid: a },
            },
        ],
        productionWork: {
            pets: { [a]: { balance: '123/7', lastWire: 17 } },
            jobs: { '500001:1': { worker: a, progress: '3/4', productGuid: 500001 } },
        },
        collectionProduction: { 500001: { pet: a, started: 123, clocks: [{ next: 456, seconds: 720 }] } },
        ranches: {
            101: {
                harvest_pet: b,
                product_pets: [{ slot: 1, pet_guid: a }],
                drops: [{ guid: 500001, pet_guid: a, item_id: 500001, count: 3 }],
                bonus: { pendingBonus: [{ pet_guid: a, triggerBaseGuid: 500001 }] },
            },
        },
    }
    state.roulettes = { 1: { type: 1, guid: [a, b, '0'] }, 3: { type: 3, guid: [a, '0'] } }
    state.petCaressPeriods = { [a]: 20261126 }
    state.petCaressProgress = { guid: a, consecutive: 3, maximum: 7 }
    state.petSkillRolls = { [a]: { fail_vec: [true], request_key: 'raw' } }
    state.petEvolutionProfiles = { [a]: { 500001: { labor_infos: [] } } }
    state.petEvolutionHistory = { [a]: [{ from: 500001, to: 500002, time: 12 }] }
    state.petStarSoulProgress = {
        version: 1,
        migration: 'current-trained-lower-bound',
        revision: 1,
        entries: { [a]: { configId: 500001, level: '25769803777' } },
    }
    state.petCaptureResults = { [a]: { guid: a, pet_id: 500001 } }
    state.hatchReceipts = { '500001:500001': { petGuid: b, petId: 500001, eggGuid: 500001 } }
    state.charKiboClaims = { 500001: { guid: a, pet_id: 500001, hero_id: 500001 } }
    state.playableChoiceReceipts = { '106010:0:60001': { pet_guid: a, pet_group: 500001 } }
    state.playableRuns = { 60001: { selected_pet_guid: a } }
    state.playableFinishes = copy(state.playableRuns)
    state.activities = {
        1: {
            kiboTour: { runs: { 1: { pet_ids: [a, b], pet_experience: [{ pet_id: a, config_id: 500001, gain: 8 }] } } },
            unrelated: 500001,
        },
    }
    state.mountRideId = a
    Object.assign(state.world, { mount: a, status: 1, status_arg: a, mountActionLifecycle: { mount: a, epoch: 7 } })
    state.entrust = { run: { repeat_formation: { slots: [{ pet_id: a }] } } }
    state.compatibilityDiagnostics = { suspendedHeroPetBindings: { [a]: { hero_id: hero.guid } } }
    const before = copy(state),
        result = migratePetGuidIdentity(tables, state, protocol),
        x = result.mapping[a],
        y = result.mapping[b]
    assert.equal(result.identitiesChanged, true)
    assert.equal(result.mapping[canonical], undefined)
    assert.equal(state.pets[2].guid, canonical)
    assert.ok(parsePetGuid(x).index > 700000)
    assert.deepEqual(withoutGuid(state.pets), withoutGuid(before.pets))
    assert.deepEqual(state.player.sbag_infos, before.player.sbag_infos)
    assert.equal(state.player.heros_info.heros[0].pet_id, x)
    assert.equal(state.homeFormationBackup.groups[0].heros[0].pet_id, x)
    assert.equal(state.player.basic_info.info.pet[0].id, 500001)
    assert.equal(state.player.basic_info.info.pet[0].guid, x)
    assert.deepEqual(state.home.stationPets, [x])
    assert.equal(state.home.builds[0].guid, 500001)
    assert.deepEqual(state.home.builds[0].auto_info, { plant_pet: x, water_pet: y, harvest_pet: x })
    assert.deepEqual(state.home.productionWork.pets[x], before.home.productionWork.pets[a])
    assert.equal(state.home.productionWork.jobs['500001:1'].worker, x)
    assert.equal(state.home.collectionProduction[500001].pet, x)
    assert.equal(state.home.collectionProduction[500001].clocks[0].next, 456)
    assert.equal(state.home.ranches[101].harvest_pet, y)
    assert.equal(state.home.ranches[101].product_pets[0].pet_guid, x)
    assert.deepEqual(
        state.home.ranches[101].drops,
        before.home.ranches[101].drops,
        'sealed producer history remains raw',
    )
    assert.deepEqual(state.home.ranches[101].bonus, before.home.ranches[101].bonus)
    assert.deepEqual(state.roulettes[3], before.roulettes[3])
    assert.deepEqual(state.roulettes[1].guid, [x, y, '0'])
    assert.equal(state.charKiboClaims[500001].guid, x)
    assert.equal(state.petCaptureResults[a].guid, x)
    assert.equal(state.hatchReceipts['500001:500001'].petGuid, y)
    assert.equal(state.hatchReceipts['500001:500001'].petId, 500001)
    assert.equal(state.petCaressPeriods[x], 20261126)
    assert.equal(state.petCaressProgress.guid, x)
    assert.deepEqual(state.petEvolutionHistory[x], before.petEvolutionHistory[a])
    assert.equal(Object.keys(state.petStarSoulProgress.entries).length, 1)
    assert.equal(state.playableFinishes[60001].selected_pet_guid, x)
    assert.equal(state.entrust.run.repeat_formation.slots[0].pet_id, x)
    assert.deepEqual(state.activities[1].kiboTour.runs[1].pet_ids, [x, y])
    assert.equal(state.activities[1].kiboTour.runs[1].pet_experience[0].pet_id, x)
    assert.equal(state.world.mount, x)
    assert.equal(state.world.status_arg, x)
    assert.equal(state.world.mountActionLifecycle.epoch, 7)
    assert.deepEqual(state.compatibilityDiagnostics, before.compatibilityDiagnostics)
    const stable = copy(state)
    assert.equal(migratePetGuidIdentity(tables, state, protocol).changed, false)
    assert.deepEqual(state, stable)
    const issued = createPets(tables, state, 500001, 2, 1001, () => 0)
    assert.ok(issued.every((pet) => !state.petGuidMigration.aliases[pet.guid] && parsePetGuid(pet.guid).ownerId === 19))
})

test('lossless current/old TrialPet preset patch preserves unknown bytes, trial identities and original base64 archive', () => {
    const state = legacy(),
        a = state.pets[0].guid
    const owned = protocol.encode('cs.TrialPet', { guid: a, id: a, is_trial: false }),
        trial = protocol.encode('cs.TrialPet', { guid: a, id: a, is_trial: true })
    const unknown = Buffer.from([0x98, 0x06, 0xad, 0x01]),
        ownedBody = Buffer.concat([owned, unknown])
    const bytes = Buffer.concat([
        Buffer.from([0x12, ownedBody.length]),
        ownedBody,
        Buffer.from([0x12, trial.length]),
        trial,
        unknown,
    ])
    const original = bytes.toString('base64')
    state.player.group_mgrs.find((row) => row.type === 6).groups = [{ id: 1, pet_duel_group_info: original, heros: [] }]
    const { mapping } = migratePetGuidIdentity(tables, state, protocol)
    const patched = Buffer.from(
        state.player.group_mgrs.find((row) => row.type === 6).groups[0].pet_duel_group_info,
        'base64',
    )
    const decoded = protocol.decode('cs.PetDuelGroupInfo', patched)
    assert.equal(decoded.pet_guids[0].guid, mapping[a])
    assert.equal(decoded.pet_guids[0].id, mapping[a])
    assert.equal(decoded.pet_guids[1].guid, a)
    assert.equal(decoded.pet_guids[1].id, a)
    assert.equal(patched.subarray(-unknown.length).equals(unknown), true)
    assert.equal(patched.indexOf(unknown) >= 0, true)
    assert.equal(state.petGuidMigration.encodedPresets[0].original, original)
})

test('legitimate old pending accepts or retains its exact proposal while paid receipts and all hash originals remain immutable', () => {
    for (const accept of [true, false]) {
        const state = legacy(),
            old = state.pets[0].guid
        storedProposal(state)
        const pending = copy(state.petMutation.pets[old].pending),
            originalGenes = copy(state.pets[0].gene_infos)
        const key = mutationSourceReceiptKey(19, '1'),
            receipt = {
                version: 1,
                key,
                primary: {
                    local_claim_id: '1',
                    qualification_snapshot: {
                        beneficiaries: [{ pet_guid: old, bindings: [{ slot_pet: { value: old } }] }],
                    },
                },
                pets: [{ pet_guid: old, status: 'planned' }],
            }
        state.petMutation.claimResults[key] = copy(receipt)
        const { mapping } = migratePetGuidIdentity(tables, state, protocol),
            current = mapping[old],
            active = state.petMutation.pets[current].pending
        assert.deepEqual({ ...active, petGuid: old }, pending)
        assert.deepEqual(findMutationSourceReceipt(state, key), receipt)
        confirmMutation(tables, state, current, accept, 1800000001)
        assert.equal(state.pets[0].mutation_times, pending.counterAfter)
        assert.deepEqual(state.pets[0].gene_infos[0], accept ? pending.candidate : originalGenes[0])
        assert.equal(state.petMutation.pets[current].resolutions[pending.generation].baseHash, pending.baseHash)
        assert.deepEqual(state.petMutation.claimResults[key], receipt)
    }
})

test('proof substitutes only original identity: current genome/config changes still reject accept, explicit keep keeps its former semantics', () => {
    const state = legacy(),
        old = state.pets[0].guid
    storedProposal(state)
    const { mapping } = migratePetGuidIdentity(tables, state, protocol),
        current = mapping[old]
    state.pets[0].config_id = 500002
    const before = copy(state)
    assert.throws(
        () => confirmMutation(tables, state, current, true, 1800000001),
        (error) => error.code === ErrorCode.InvalidLogic,
    )
    assert.deepEqual(state, before)
    confirmMutation(tables, state, current, false, 1800000001)
    assert.equal(state.pets[0].config_id, 500002)
    assert.equal(state.pets[0].mutation_times, 2)
    const invalid = legacy(),
        guid = invalid.pets[0].guid
    storedProposal(invalid)
    invalid.pets[0].config_id = 500002
    const raw = copy(invalid)
    assert.throws(
        () => migratePetGuidIdentity(tables, invalid, protocol),
        (error) => error.code === ErrorCode.InvalidLogic,
    )
    assert.deepEqual(invalid, raw)
})

test('migration proof cannot change account, generation, credit preimage or the durable candidate artifact', () => {
    for (const tamper of [
        (state, current) => {
            state.petGuidMigration.ownerId++
        },
        (state, current) => {
            state.petMutation.pets[current].pending.generation = '2'
            state.petMutation.generationHighWater = '2'
        },
        (state, current) => {
            const pending = state.petMutation.pets[current].pending
            pending.counterBefore++
            pending.counterAfter++
        },
        (state, current) => {
            const pending = state.petMutation.pets[current].pending
            pending.candidate.gene_id++
            state.pets[0].mutation_info.gene_id++
        },
    ]) {
        const state = legacy()
        storedProposal(state)
        const { mapping } = migratePetGuidIdentity(tables, state, protocol),
            current = mapping['500001']
        tamper(state, current)
        const before = copy(state)
        assert.throws(
            () => confirmMutation(tables, state, current, false, 1800000001),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(state, before)
    }
})

test('account-scoped old collisions migrate to distinct identities without touching each other or inferring species from an old GUID', () => {
    const left = legacy(19),
        right = legacy(20),
        wrong = left.pets[1].guid
    assert.equal(right.pets[1].guid, wrong)
    const first = migratePetGuidIdentity(tables, left, protocol),
        second = migratePetGuidIdentity(tables, right, protocol)
    assert.notEqual(first.mapping[wrong], second.mapping[wrong])
    assert.equal(parsePetGuid(first.mapping[wrong]).ownerId, 19)
    assert.equal(parsePetGuid(second.mapping[wrong]).ownerId, 20)
    assert.equal(left.pets[1].config_id, 500002)
    assert.equal(right.pets[1].config_id, 500002)
})

test('ranch exact old raw request replay is recognized before owned lookup without rewriting any receipt hash', () => {
    const state = legacy(),
        request = { block_id: 101, slot: 1, pet_guid: state.pets[0].guid, work_type: 1, out_hub: false },
        requestKey = 'private-session:6090:19'
    state.ranchWorkReceipts = [{ key: digest(requestKey), payload: digest(JSON.stringify(request)) }]
    const receipt = copy(state.ranchWorkReceipts),
        handlers = new Map()
    registerRanch((name, fn) => handlers.set(name, fn), tables)
    migratePetGuidIdentity(tables, state, protocol)
    const before = copy(state)
    assert.deepEqual(handlers.get('RanchSetPetOption')({ state, requestKey }, request), {})
    assert.deepEqual(state, before)
    assert.deepEqual(state.ranchWorkReceipts, receipt)
    assert.throws(
        () => handlers.get('RanchSetPetOption')({ state, requestKey }, { ...request, slot: 2 }),
        (error) => error.code === ErrorCode.InvalidPacket,
    )
    assert.deepEqual(state, before)
})

test('old missing-config acquisition history is archived before current catalog projection without deleting retained assets', () => {
    const state = legacy(),
        missing = 500189
    state.pets.push({ ...copy(state.pets[0]), guid: String(missing), config_id: missing, hero_id: '0', box_id: 104 })
    state.recordPets = [500001, missing]
    migratePetGuidIdentity(tables, state, protocol)
    assert.deepEqual(state.petGuidMigration.catalogHistory.recordPets, [500001, missing])
    repairPetCatalog(tables, state)
    assert.equal(state.recordPets.includes(missing), false)
    const payload = petSyncPresentation(tables, state, {
        pet_infos: { pets: state.pets },
        record_pets: state.recordPets,
    })
    assert.equal(
        payload.pet_infos.pets.some((pet) => pet.config_id === missing),
        false,
    )
    assert.equal(state.pets.length, 4)
    assert.ok(state.pets.some((pet) => pet.config_id === missing))
})

test('ambiguous identity, malformed encoded preset and corrupt typed reservation fail before touching caller assets or borrowed nested objects', () => {
    for (const corrupt of [
        (state) => state.pets.push(copy(state.pets[0])),
        (state) =>
            state.player.group_mgrs
                .find((row) => row.type === 6)
                .groups.push({ id: 1, pet_duel_group_info: Buffer.from([0x12, 0xff]).toString('base64') }),
        (state) => {
            state.petCaressPeriods = { broken: 2 }
        },
    ]) {
        const state = legacy()
        corrupt(state)
        const before = copy(state),
            borrowed = state.pets[0]
        assert.throws(
            () => migratePetGuidIdentity(tables, state, protocol),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(state, before)
        assert.deepEqual(borrowed, before.pets[0])
    }
})

test('released canonical identity present only in immutable history reserves space and is not recycled by migration or later allocation', () => {
    const state = legacy(),
        released = permanentPetGuid(19, 900000),
        key = mutationSourceReceiptKey(19, '1')
    state.petEvolutionHistory = { [released]: [{ from: 500001, to: 500002, time: 1 }] }
    state.activities = {
        1: { kiboTour: { receipts: { 1: { pet_ids: [released], experience: [{ pet_id: released, gain: 1 }] } } } },
    }
    state.petMutation = {
        version: 1,
        generationHighWater: '0',
        pets: {},
        claimResults: { [key]: { version: 1, key, primary: { local_claim_id: '1' }, pets: [{ pet_guid: released }] } },
    }
    const paid = copy(state.petMutation.claimResults),
        tour = copy(state.activities)
    const result = migratePetGuidIdentity(tables, state, protocol)
    assert.ok(Object.values(result.mapping).every((guid) => parsePetGuid(guid).index > 900000))
    assert.deepEqual(state.petMutation.claimResults, paid)
    assert.deepEqual(state.activities, tour)
    assert.ok(state.petEvolutionHistory[released])
    assert.ok(!result.mapping[released])
    assert.ok(createPets(tables, state, 500001, 1, 1001, () => 0)[0].guid !== released)
})

test('migration aliases reserve already issued nonstarter identities even after release and a missing allocation envelope', () => {
    const state = legacy(),
        { mapping } = migratePetGuidIdentity(tables, state, protocol)
    const highest = Math.max(...Object.values(mapping).map((guid) => parsePetGuid(guid).index))
    state.pets = []
    delete state.petGuidAllocation
    const pet = createPets(tables, state, 500001, 1, 1001, () => 0)[0]
    assert.equal(parsePetGuid(pet.guid).index, highest + 1)
    assert.ok(!Object.values(mapping).includes(pet.guid))
})

test('real current Abyss roster and persistent checkpoint retain FO31 source/attrs/HP and pass existing resume validation after migration', () => {
    const state = legacy(),
        old = state.pets[0].guid,
        level = tables.find('abbys_level', 20001)
    const request = {
        challenge_list: String(level.dungeonId)
            .split('|')
            .map((id, index) => ({
                dungeon_id: Number(id),
                control: state.player.heros_info.heros[index].guid,
                heros: [
                    {
                        index: 0,
                        hero: {
                            hero_guid: state.player.heros_info.heros[index].guid,
                            pet_guid: index === 0 ? old : '0',
                        },
                    },
                    { index: 1, hero: { hero_guid: '0', pet_guid: '0' } },
                    { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
                ],
            })),
    }
    const roster = abyssChallengeRoster(tables, state, level, request),
        checkpoint = {
            version: 1,
            mode: level.mode,
            level_id: level.id,
            rotation_id: 0,
            completed_parts: 1,
            total_battle_time: 12,
            dead_hero_ids: [],
            ...copy(roster),
        }
    checkpoint.challenges[0].win = true
    checkpoint.challenges[0].battle_time = 12
    state.abyssRun = {
        ...copy(roster),
        pet_hp: { [abyssPetGuid(old)]: 17 },
        previous_manager: copy(state.player.group_mgrs[0]),
    }
    state.abyss = {
        modes: {
            [level.mode]: {
                levels: { [level.id]: { resume: checkpoint, challenge_list: copy(checkpoint.challenges) } },
            },
        },
    }
    const rawAttributes = copy(roster.petAttrs[abyssPetGuid(old)]),
        result = migratePetGuidIdentity(tables, state, protocol),
        current = result.mapping[old],
        actor = abyssPetGuid(current)
    assert.equal(state.abyssRun.pets[0].guid, actor)
    assert.equal(state.abyssRun.pets[0].source_guid, current)
    assert.equal(state.abyssRun.pet_hp[actor], 17)
    assert.deepEqual({ ...state.abyssRun.petAttrs[actor], hero_guid: abyssPetGuid(old) }, rawAttributes)
    assert.equal(state.abyssRun.challenges[0].heros[0].hero.pet_guid, actor)
    const nextRequest = copy(request)
    nextRequest.challenge_list[0].heros[0].hero.pet_guid = current
    const expected = abyssChallengeRoster(tables, state, level, nextRequest),
        saved = state.abyss.modes[level.mode].levels[level.id].resume
    assert.equal(validateAbyssCheckpoint(saved, expected, level, null), saved)
    assert.equal(saved.total_battle_time, 12)
    assert.equal(saved.completed_parts, 1)
})

test('combat and arena typed actor references migrate without rewriting bullet/element/config keys, enemies, trial profiles or historic digests', () => {
    const state = legacy(),
        a = state.pets[0].guid,
        b = state.pets[1].guid,
        hero = state.player.heros_info.heros[0].guid,
        enemy = ((4n << 56n) | 123n).toString()
    state.combat = {
        entities: { [a]: { uuid: a, hp: 13, max_hp: 20 }, [enemy]: { uuid: enemy, hp: 0, final_blow_guid: a } },
        enemyTerminals: { [enemy]: { final_blow_guid: a, generation: 7 } },
        skills: { [a]: { unit_id: a, skill_id: 500001 } },
        bullets: { [a]: { unit_id: a, conf_id: 500001 } },
        reboundRequests: { [a]: { cast_id: a, target_id: a } },
        elements: {
            [a]: { tar_id: b, uniqueId: a, buff: { attacker_id: a, source_id: a, executor_id: hero, cfg_id: 500001 } },
        },
        petSp: { [a]: 17 },
        energySpecs: { [a]: { kind: 'pet', maxSp: 100, rate: 3 } },
        energyRemainders: { [a]: 77 },
        energyActorKey: `${hero}:${a}`,
        shields: { [a]: [{ id: 500001, val: 4 }] },
        skillEffects: { [`${a}:500001`]: { uuid: a, skill_id: 500001, updated_at: 1 } },
        perfectDefenses: { [`${a}:${enemy}`]: { defender: a, target: enemy, time: 2 } },
        combineAttacks: { [`${a}:${enemy}`]: { attack_id: a, target_id: enemy, begin_at: 3 } },
        npcDuel: {
            formation_snapshot: {
                pet_guids: [
                    { id: a, guid: a, is_trial: false },
                    { id: a, guid: a, is_trial: true },
                ],
            },
            actors: { 17: { camp: 1, source_guid: a }, 18: { camp: 2, source_guid: a } },
            ultra_choices: { [a]: true },
        },
    }
    state.retiredNpcArenaActors = { 17: { camp: 1, source_guid: a }, 18: { camp: 2, source_guid: a } }
    state.combat.summons = {
        777: { unit_id: '777', owner_id: a, native_owner: { status: 'known', guid: a, kind: 'pet' } },
    }
    state.combat.summonRequests = { 11: { unit_id: '777', owner_id: a, config_id: 500001 } }
    state.combat.hatred = {
        objects: { [a]: { id: a, target_obj_ids: [b, enemy], player_obj_ids: [500001, 19] } },
        players: {},
    }
    state.combat.petPresentation = { [a]: { type: 3, updated_at: 12 } }
    state.combat.kiboDuelTreeReport = { guids: [a, b], received_at: 12 }
    state.trialGroup = { pets: [{ guid: a, config_id: 500001 }], petIds: [500001], heroes: [] }
    state.kiboDuelTrialProfiles = { 500001: { guid: a } }
    state.retiredTrialActors = [a]
    state.petHandbookCastReceipts = [digest(a)]
    state.personalBuffSources = { 7001: { actorUuid: a, elementConfigId: 500001 } }
    const before = copy(state),
        { mapping } = migratePetGuidIdentity(tables, state, protocol),
        x = mapping[a],
        y = mapping[b],
        battle = state.combat
    assert.equal(battle.entities[x].hp, 13)
    assert.equal(battle.entities[enemy].uuid, enemy)
    assert.equal(battle.entities[enemy].final_blow_guid, x)
    assert.equal(battle.enemyTerminals[enemy].generation, 7)
    assert.equal(battle.enemyTerminals[enemy].final_blow_guid, x)
    assert.equal(battle.skills[x].unit_id, x)
    assert.equal(battle.skills[x].skill_id, 500001)
    assert.equal(battle.bullets[a].unit_id, x)
    assert.equal(battle.reboundRequests[a].cast_id, x)
    assert.equal(battle.reboundRequests[a].target_id, a)
    assert.equal(battle.elements[a].tar_id, y)
    assert.equal(battle.elements[a].uniqueId, a)
    assert.equal(battle.elements[a].buff.source_id, x)
    assert.equal(battle.elements[a].buff.cfg_id, 500001)
    assert.equal(battle.petSp[x], 17)
    assert.equal(battle.energyRemainders[x], 77)
    assert.equal(battle.energyActorKey, `${hero}:${x}`)
    assert.deepEqual(battle.shields[x], before.combat.shields[a])
    assert.ok(battle.skillEffects[`${x}:500001`])
    assert.equal(battle.perfectDefenses[`${x}:${enemy}`].target, enemy)
    assert.equal(battle.combineAttacks[`${x}:${enemy}`].begin_at, 3)
    assert.equal(battle.npcDuel.actors[17].source_guid, x)
    assert.equal(battle.npcDuel.actors[18].source_guid, a)
    assert.equal(battle.npcDuel.formation_snapshot.pet_guids[1].id, a)
    assert.equal(state.retiredNpcArenaActors[17].source_guid, x)
    assert.equal(state.retiredNpcArenaActors[18].source_guid, a)
    assert.deepEqual(state.trialGroup, before.trialGroup)
    assert.deepEqual(state.kiboDuelTrialProfiles, before.kiboDuelTrialProfiles)
    assert.deepEqual(state.retiredTrialActors, before.retiredTrialActors)
    assert.deepEqual(state.petHandbookCastReceipts, before.petHandbookCastReceipts)
    assert.equal(state.personalBuffSources[7001].actorUuid, x)
    assert.equal(battle.summons[777].unit_id, '777')
    assert.equal(battle.summons[777].owner_id, x)
    assert.equal(battle.summons[777].native_owner.guid, x)
    assert.equal(battle.summonRequests[11].owner_id, x)
    assert.equal(battle.summonRequests[11].config_id, 500001)
    assert.deepEqual(battle.hatred.objects[x], { id: x, target_obj_ids: [y, enemy], player_obj_ids: [500001, 19] })
    assert.equal(battle.petPresentation[x].updated_at, 12)
    assert.deepEqual(battle.kiboDuelTreeReport.guids, [x, y])
})

test('real memory Game login migration and codec rollback preserve assets before cold canonical sync and repeated login', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, payload) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: row.id, seq: seq++, payload: protocol.encode(row.req, payload) })
    }
    const transact = store.transact.bind(store)
    registerPetMutations(
        (name, handler) => game.handlers.set(protocol.byName.get('CSProto' + name).id, handler),
        tables,
        { privateEnabled: true },
    )
    try {
        call('EnterGame', { open_id: 'private-guid-migration-game' })
        transact(session.id, 0, (state) => {
            for (const pet of state.pets) pet.guid = String(pet.config_id)
            delete state.petGuidAllocation
            delete state.petProvenance
            delete state.petGuidMigration
            storedProposal(state)
        })
        const before = store.load(session.id),
            encode = protocol.encode,
            wireType = protocol.byName.get('CSProtoPetInfoSync').rsp
        store.transact = (id, message, fn, options) =>
            transact(
                id,
                message,
                (state, context) => {
                    migratePetGuidIdentity(tables, state, protocol)
                    return fn(state, context)
                },
                options,
            )
        try {
            protocol.encode = function (type, payload) {
                if (type === wireType) throw Error('migration wire rollback')
                return encode.call(this, type, payload)
            }
            session = {}
            assert.throws(
                () => call('EnterGame', { open_id: 'private-guid-migration-game' }),
                /migration wire rollback/,
            )
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(store.load(session.id), before)
        session = {}
        const packets = call('EnterGame', { open_id: 'private-guid-migration-game' }),
            after = store.load(session.id).state
        assert.deepEqual(withoutGuid(after.pets), withoutGuid(before.state.pets))
        assert.ok(
            after.pets.every((pet) => {
                const id = parsePetGuid(pet.guid)
                return id.type === 2 && id.ownerId === session.id
            }),
        )
        const shown = packets
            .filter((row) => row.id === 6517)
            .flatMap((row) => protocol.decode(wireType, row.payload).pet_infos.pets)
        assert.equal(shown.length, after.pets.length)
        assert.deepEqual(after.recordPets, [])
        const current = after.petGuidMigration.aliases['500001'],
            pending = copy(after.petMutation.pets[current].pending),
            beforeChoice = store.load(session.id),
            choiceType = protocol.byName.get('CSProtoChoseMutation').rsp
        try {
            protocol.encode = function (type, payload) {
                if (type === choiceType) throw Error('migrated candidate codec rollback')
                return encode.call(this, type, payload)
            }
            assert.throws(
                () => call('ChoseMutation', { pet_guid: current, is_accept: true }),
                /migrated candidate codec rollback/,
            )
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(store.load(session.id), beforeChoice)
        call('ChoseMutation', { pet_guid: current, is_accept: true })
        assert.equal(
            store.load(session.id).state.petMutation.pets[current].resolutions[pending.generation].baseHash,
            pending.baseHash,
        )
        const identity = copy({
            migration: after.petGuidMigration,
            allocation: after.petGuidAllocation,
            source: after.petProvenance,
        })
        session = {}
        call('EnterGame', { open_id: 'private-guid-migration-game', reconnect: true })
        const reopened = store.load(session.id).state
        assert.deepEqual(
            {
                migration: reopened.petGuidMigration,
                allocation: reopened.petGuidAllocation,
                source: reopened.petProvenance,
            },
            identity,
        )
    } finally {
        store.close()
    }
})
