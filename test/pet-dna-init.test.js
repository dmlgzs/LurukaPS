import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { initialPetGenes } from '../src/pets.js'
import { petModules } from '../src/battle.js'
import { effectGeneSkills } from '../src/pet-dna-skills.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration()
const tables = new Tables(cfg.tables)
const protocol = new Protocol(cfg.base)
const module5 = (view) => view.modules.find((row) => row.module_type === 5).sub_modules[0]
function fixture(name, filename = ':memory:') {
    const store = new Store(filename)
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: row.id, seq: seq++, payload: protocol.encode(row.req, data) })
    }
    return {
        store,
        game,
        get session() {
            return session
        },
        call,
        reconnect: () => {
            session = {}
            return call('Login', { open_id: name })
        },
        state: () => store.load(session.id).state,
    }
}
const genes = (state) => state.pets.map((pet) => ({ guid: pet.guid, gene_infos: pet.gene_infos }))
const inventory = (state) => ({
    attrs: state.player.attr_infos,
    bag: state.player.sbag_infos,
    tbag: state.player.tbag_infos,
})
const decode10006 = (packets) =>
    packets
        .filter((packet) => packet.id === 10006)
        .flatMap((packet) => protocol.decode('SCHeroAttrInfoSync', packet.payload).heros)

test('all current birth effect DNA and all 42 strictly increasing innate targets have real level1 passive logic and exact initialization descriptors', () => {
    const logic = new Map(tables.get('skillsub_logic').map((row) => [row.skillId, row]))
    const dna = new Map(tables.get('pet_dna').map((row) => [row.id, row]))
    const skills = new Map(tables.get('skill').map((row) => [row.id, row]))
    const levelOne = new Set(
        tables
            .get('skill_level')
            .filter((row) => row.level === 1)
            .map((row) => row.skillId),
    )
    const birth = new Set()
    for (const config of tables.get('pet')) {
        const list = initialPetGenes(tables, config)
        const effect = list.filter((gene) => skills.get(gene.gene_id)?.skillType === 1)
        for (const gene of effect) {
            assert.ok(levelOne.has(gene.gene_id))
            assert.equal(logic.get(gene.gene_id)?.skillLogicType, 6, `${config.id}:${gene.gene_id}`)
            birth.add(gene.gene_id)
        }
        assert.deepEqual(
            effectGeneSkills(tables, { guid: 'birth', lv: 1, gene_infos: list }),
            effect.map((gene) => ({ skill_id: gene.gene_id, skill_lv: 1, skill_slot: 0, type: 0 })),
        )
    }
    assert.ok(birth.size > 0)
    const upgrades = [...dna.values()].filter((row) => row.evoDnaId && row.evoDnaId !== row.id)
    assert.equal(upgrades.length, 42)
    for (const row of upgrades) {
        const target = dna.get(row.evoDnaId)
        assert.ok(target.rarity > row.rarity && levelOne.has(target.id))
        assert.equal(logic.get(target.id)?.skillLogicType, 6)
        assert.deepEqual(
            effectGeneSkills(tables, {
                guid: 'evo-contract',
                lv: 1,
                gene_infos: [{ pos: 1, gene_id: target.id, gene_lv: 1 }],
            }),
            [{ skill_id: target.id, skill_lv: 1, skill_slot: 0, type: 0 }],
        )
    }
})

test('real 5001 produces owned effect skills on 10006 without changing raw genes or rewards across duplicate entry and SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dna-init-'))
    const filename = path.join(dir, 'private.sqlite')
    const f = fixture('dna-entry-owned', filename)
    let expected
    try {
        f.call('Login', { open_id: 'dna-entry-owned' })
        const packets = f.call('EnterGame', { open_id: 'dna-entry-owned' })
        const state = f.state()
        const pet = state.pets.find((row) => effectGeneSkills(tables, row).length > 0)
        assert.ok(pet)
        const wire = decode10006(packets).find((row) => row.hero_guid === pet.guid)
        assert.ok(wire)
        assert.deepEqual(module5(wire).skills.skills, effectGeneSkills(tables, pet))
        assert.deepEqual(module5(wire).attrs, module5(petModules(tables, state, pet, [])).attrs)
        assert.deepEqual(
            wire.modules.find((row) => row.module_type === 4).sub_modules[0].skills.skills,
            pet.inherent_skills,
        )
        expected = { genes: genes(state), inventory: inventory(state) }
        f.reconnect()
        const again = f.call('EnterGame', { open_id: 'dna-entry-owned' })
        assert.deepEqual(genes(f.state()), expected.genes)
        assert.deepEqual(inventory(f.state()), expected.inventory)
        assert.deepEqual(
            module5(decode10006(again).find((row) => row.hero_guid === pet.guid)).skills.skills,
            module5(wire).skills.skills,
        )
        for (const view of decode10006(again)) {
            if (!view.modules.some((row) => row.module_type === 5)) continue
            const ids = module5(view).skills.skills.map((row) => row.skill_id)
            assert.equal(new Set(ids).size, ids.length)
        }
    } finally {
        f.store.close()
    }
    const reopened = fixture('dna-entry-owned', filename)
    try {
        reopened.call('Login', { open_id: 'dna-entry-owned' })
        const packets = reopened.call('EnterGame', { open_id: 'dna-entry-owned' })
        assert.deepEqual(genes(reopened.state()), expected.genes)
        assert.deepEqual(inventory(reopened.state()), expected.inventory)
        assert.ok(
            decode10006(packets).some((row) =>
                row.modules.some(
                    (module) => module.module_type === 5 && module.sub_modules[0].skills.skills.length > 0,
                ),
            ),
        )
    } finally {
        reopened.store.close()
        assert.ok(dir.startsWith(path.join(os.tmpdir(), 'pet-dna-init-')))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('legacy unknown DNA stays raw while valid effects initialize; 10006 codec failure rolls the real entry transaction back', () => {
    const f = fixture('dna-legacy-preserved')
    const warn = console.warn
    const seen = []
    try {
        f.call('Login', { open_id: 'dna-legacy-preserved' })
        f.call('EnterGame', { open_id: 'dna-legacy-preserved' })
        let guid
        f.store.transact(f.session.id, 0, (state) => {
            const pet = state.pets.find((row) => effectGeneSkills(tables, row).length > 0)
            guid = pet.guid
            pet.gene_infos = [
                pet.gene_infos.find((gene) => tables.find('skill', gene.gene_id)?.skillType === 1),
                { pos: 2, gene_id: 533822, gene_lv: 1 },
                { pos: 3, gene_id: 999999999, gene_lv: 1 },
            ]
            pet.gene_infos[0].pos = 1
        })
        const raw = structuredClone(f.state().pets.find((pet) => pet.guid === guid).gene_infos)
        console.warn = (...args) => seen.push(args)
        const higherLevel = { guid, lv: 1, gene_infos: [{ ...raw[0], gene_lv: 2 }] }
        const higherRaw = structuredClone(higherLevel)
        assert.deepEqual(effectGeneSkills(tables, higherLevel), [])
        assert.deepEqual(higherLevel, higherRaw)
        assert.ok(seen.some((args) => String(args[1]).includes('legacy-effect-level-not-proven')))
        const missingUnlock = {
            get: (name) =>
                name === 'game'
                    ? tables.get(name).map((row) =>
                          row.title === 'PET_DNAUNLOCK_NEW'
                              ? {
                                    ...row,
                                    value: String(row.value)
                                        .split('|')
                                        .filter((token) => !token.startsWith('8#'))
                                        .join('|'),
                                }
                              : row,
                      )
                    : tables.get(name),
        }
        assert.throws(
            () => effectGeneSkills(missingUnlock, higherRaw),
            (error) => error.code === ErrorCode.GameConfig,
        )
        f.reconnect()
        const packets = f.call('EnterGame', { open_id: 'dna-legacy-preserved' })
        assert.deepEqual(f.state().pets.find((pet) => pet.guid === guid).gene_infos, raw)
        assert.equal(module5(decode10006(packets).find((row) => row.hero_guid === guid)).skills.skills.length, 1)
        assert.ok(seen.some((args) => String(args[1]).includes('533822')))
        f.reconnect()
        const before = structuredClone(f.state())
        const encode = protocol.encode.bind(protocol)
        let intercepted = false
        protocol.encode = (name, value) => {
            if (name.endsWith('SCHeroAttrInfoSync')) {
                intercepted = true
                throw Error('injected-dna-init-codec-failure')
            }
            return encode(name, value)
        }
        try {
            assert.throws(
                () => f.call('EnterGame', { open_id: 'dna-legacy-preserved' }),
                /injected-dna-init-codec-failure/,
            )
            assert.equal(intercepted, true)
            assert.deepEqual(f.state(), before)
        } finally {
            protocol.encode = encode
        }
        let sinkAttempted = false
        console.warn = () => {
            sinkAttempted = true
            throw Error('diagnostic-sink-failure')
        }
        effectGeneSkills(tables, { guid, lv: 1, gene_infos: [{ pos: 1, gene_id: 999999998, gene_lv: 1 }] })
        assert.equal(sinkAttempted, true)
        f.reconnect()
        assert.doesNotThrow(() => f.call('EnterGame', { open_id: 'dna-legacy-preserved' }))
        assert.deepEqual(f.state().pets.find((pet) => pet.guid === guid).gene_infos, raw)
    } finally {
        console.warn = warn
        f.store.close()
    }
})
