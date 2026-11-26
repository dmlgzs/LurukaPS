import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { repairTrialActorGuids } from '../src/handlers/trial-groups.js'
import { petModules, pairs } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'
import { hydrateTrialPet, trialPetHydrationDefinition } from '../src/trial-pet-hydration.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    guid = (id, owner = 1) => ((9n << 56n) | (BigInt(id) << 32n) | BigInt(owner)).toString(),
    ids = [
        ...new Set(
            tables.get('heropet_interim_group').flatMap((row) =>
                String(row.pet_id ?? '')
                    .split('|')
                    .filter(Boolean)
                    .map((p) => Number(p.split('#')[1])),
            ),
        ),
    ]
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const list = (s) =>
    String(s ?? '')
        .split('|')
        .filter(Boolean)
        .map((p) => p.split('#').map(Number))
function luaProjection(wire) {
    const template = Number((BigInt(wire.guid) >> 32n) & 0xffffffn),
        custom = tables.find('pet_customized', template)
    assert(custom)
    const base = tables.find('pet', custom.petId),
        source = custom.skillType === 0 ? base : custom,
        signature = Number(tables.get('game').find((r) => r.title === 'PET_SIGNATURESKILLLIST').value)
    const skills = [
        ...list(source.signatureSkillList)
            .filter((r) => r[2])
            .map((r) => ({ skill_slot: signature, skill_id: r[1], skill_lv: 1 })),
        ...list(source.breakSkillList).map((r) => ({ skill_slot: r[0], skill_id: r[1], skill_lv: 1 })),
        ...list(source.skillList)
            .filter((r) => r[2])
            .map((r) => ({ skill_slot: r[0], skill_id: r[1], skill_lv: 1 })),
    ]
    const fixed = [
        ...(custom.talentDnaType ? [custom.talentDna] : []),
        ...(custom.dnaType ? String(custom.dna).split('|').filter(Boolean).map(Number) : []),
    ]
    return {
        id: custom.petId,
        level: custom.level,
        skills,
        comprehension: list(custom.petAttr).map(([attr_id, level]) => ({
            attr_id,
            level,
            init_level: level,
            value: wire.comprehension.find((r) => r.attr_id === attr_id).value,
        })),
        genes: fixed.length ? fixed : wire.gene_infos.map((r) => r.gene_id),
    }
}
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: 'hydrate-' + name })
    const graph = new TaskGraphs(tables).get(106002)
    store.transact(session.id, 0, (state) => {
        Object.assign(state.world, tables.position(tables.find('world_borthpos', 10201)))
        state.tasks = [
            {
                task_id: 106002,
                nodes: [makeNode(graph, 59, state)],
                finish_nodes: [1, 56, 65, 61, 58, 63, 62, 57],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        state.taskRecords = [{ task_id: 106001, count: 1, time: 1799999999 }]
        state.taskEpochs[106002] = 1
    })
    call('TrialGroupChange', { open: true, trial_id: 2 })
    call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
    call('MultiCampaignPlayerLoaded')
    const boss = ((3n << 56n) | 600003n).toString()
    call('TryCreateWorldObj', { objs: [boss] })
    call('TaskClientBefore', { task_id: 106002, node_id: 59 })
    return {
        protocol,
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        saved: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
    }
}
const owned = (s) => ({
    pets: s.pets,
    heroes: s.player.heros_info.heros.map(({ trial_pet, ...r }) => r),
    bag: s.player.sbag_infos,
    next: s.nextPetSequence,
    allocation: s.petGuidAllocation,
    records: s.recordPets,
})
function checkAbi(f, packets) {
    const attrs = packets
            .filter((p) => p.id === 10006)
            .flatMap((p) => f.protocol.decode(f.protocol.byId.get(10006).rsp, p.payload).heros),
        data = packets
            .filter((p) => p.id === 5988)
            .flatMap((p) => f.protocol.decode(f.protocol.byId.get(5988).rsp, p.payload).trial_pets),
        pet = data.find((p) => p.guid === guid(102, f.session.id)),
        stats = attrs.find((a) => a.hero_guid === pet?.guid)
    assert(pet && stats)
    assert.equal(stats.type, 9)
    assert.equal(pet.config_id, 500264)
    assert.deepEqual(
        pet.comprehension.map((r) => [r.attr_id, r.level, r.value]),
        [
            [1, 5, 120],
            [3, 6, 130],
            [5, 6, 130],
            [7, 5, 400],
            [229, 5, 120],
            [230, 5, 120],
        ],
    )
    assert.deepEqual(
        pet.gene_infos.map((r) => r.gene_id),
        [536018, 533046, 533047],
    )
    const skills = new Map(
        stats.modules
            .find((m) => m.module_type === 4)
            .sub_modules[0].skills.skills.map((s) => [s.skill_slot, s.skill_id]),
    )
    assert.equal(skills.get(501), 502101)
    assert.equal(skills.get(601), 50026403)
    assert.equal(skills.get(206), 50026401)
    assert.equal(skills.get(1), 502007)
    assert.equal(skills.get(2), 502003)
    const ui = luaProjection(pet)
    assert.equal(ui.id, 500264)
    assert.deepEqual(ui.genes, [536018, 533046, 533047])
    for (const skill of ui.skills) assert.equal(skills.get(skill.skill_slot), skill.skill_id)
    const base = pairs(tables.find('template_value', 500264).baseAttribute),
        growth = pairs(tables.find('template_value', 5001001).baseAttribute),
        main = stats.modules.find((m) => m.module_type === 4).sub_modules[0].attrs.attrs,
        values = new Map(main.map((r) => [r.attr_id, Number(r.attr_val)]))
    for (const [id, factor] of [
        [1, 120],
        [3, 130],
        [5, 130],
        [229, 120],
        [230, 120],
    ])
        assert.equal(values.get(id), Math.trunc((base.get(id) * growth.get(id) * factor) / 100))
    const genes = stats.modules.find((m) => m.module_type === 5).sub_modules[0].attrs.attrs,
        expected = new Map()
    for (const id of [536018, 533046, 533047])
        for (const [attr, n] of list(tables.find('skillsub_attrup', id).attributeList))
            expected.set(attr, (expected.get(attr) ?? 0) + n)
    for (const [id, n] of expected) assert.equal(Number(genes.find((r) => r.attr_id === id).attr_val), n)
    return { pet, stats }
}

function consumeColdTrialCache(f, packets, petGuid) {
    // Current0601c4f0 creates GetPet(guid,true) on10006.0601c4ed later
    //Populates the same object from5988; SyncTrialPetInfo0601c4b2 does not
    //clear attrModuleInfo/attrDict or the server skill dictionaries.
    const pets = new Map()
    const get = (guid) => {
        if (!pets.has(guid)) pets.set(guid, { guid })
        return pets.get(guid)
    }
    let placeholder
    for (const packet of packets) {
        if (packet.id === 10006)
            for (const data of f.protocol.decode(f.protocol.byId.get(10006).rsp, packet.payload).heros) {
                if (data.type !== 9) continue
                const cached = get(data.hero_guid)
                cached.serverAttr = data
                cached.hasServerAttr = true
                if (data.hero_guid === petGuid) placeholder = cached
            }
        if (packet.id === 5988)
            for (const wire of f.protocol.decode(f.protocol.byId.get(5988).rsp, packet.payload).trial_pets) {
                const cached = get(wire.guid)
                if (wire.guid === petGuid) assert.equal(cached, placeholder)
                cached.base = luaProjection(wire)
            }
    }
    const pet = pets.get(petGuid)
    assert(pet.hasServerAttr && pet.base)
    assert.equal(pet.serverAttr.hero_conf_id, pet.base.id)
    return pet
}

test('all current heropet references hydrate through customized templates and match Lua levels/genes/UI skill semantics', () => {
    assert.equal(ids.length, 8)
    for (const id of ids) {
        const profile = hydrateTrialPet(tables, id, guid(id)),
            ui = luaProjection(profile),
            definition = trialPetHydrationDefinition(tables, id)
        assert.equal(profile.config_id, ui.id)
        assert.equal(profile.lv, ui.level)
        assert(
            profile.comprehension.every((r) => r.level === ui.comprehension.find((a) => a.attr_id === r.attr_id).level),
        )
        const skills = new Map(profile.inherent_skills.map((r) => [r.skill_slot, r.skill_id]))
        for (const skill of ui.skills) assert.equal(skills.get(skill.skill_slot), skill.skill_id)
        assert.deepEqual(
            profile.gene_infos.map((r) => r.gene_id),
            ui.genes,
        )
        assert.equal(hash(hydrateTrialPet(tables, id, guid(id), profile)), hash(profile))
        assert(
            definition.comprehension.every(
                (r) =>
                    r.value ===
                    tables.get('pet_talent_upgrade').find((x) => x.attrId === r.attr_id && x.level === r.level).InterA,
            ),
        )
    }
})

test('wire-fallback trial templates preserve legitimately unlocked empty DNA slots without mutating their source', () => {
    const templateId = 621401
    const current = hydrateTrialPet(tables, templateId, guid(templateId))
    current.gene_infos = current.gene_infos.slice(0, 1)
    current.gene_state = 4
    const before = structuredClone(current)
    const restored = hydrateTrialPet(tables, templateId, guid(templateId), current)
    assert.deepEqual(restored.gene_infos, before.gene_infos)
    assert.equal(restored.gene_state, 4)
    assert.deepEqual(current, before)
    assert.equal(hydrateTrialPet(tables, templateId, guid(templateId), restored).gene_state, 4)
    for (const gene_state of [-1, 0, 5, 1.5])
        assert.throws(() => hydrateTrialPet(tables, templateId, guid(templateId), { ...current, gene_state }), {
            code: ErrorCode.GameConfig,
        })
})

test('real FSM-source group3 emits correct Abi10006 stats/DNA/501+601 skills, closes/reopens without owned acquisitions', () => {
    const f = fixture('group3')
    try {
        const before = hash(owned(f.state())),
            packets = f.call('TrialGroupChange', { open: true, trial_id: 3 })
        assert(packets.findIndex((p) => p.id === 5987) < packets.findIndex((p) => p.id === 10006))
        assert(packets.findIndex((p) => p.id === 10006) < packets.findIndex((p) => p.id === 5988))
        const first = checkAbi(f, packets)
        const cached = consumeColdTrialCache(f, packets, first.pet.guid)
        assert.deepEqual(cached.serverAttr, first.stats)
        if (process.env.LURUKAPS_TRIAL_HYDRATION_EVIDENCE)
            fs.writeFileSync(
                process.env.LURUKAPS_TRIAL_HYDRATION_EVIDENCE,
                JSON.stringify(
                    {
                        origin: 'Private real Game dispatch with frozen current FSM authorization + hydration overlay, not Unity execution',
                        pet: first.pet,
                        attributes: first.stats,
                        packetOrder: packets.map((p) => p.id),
                        coldCacheHasServerAttrs: cached.hasServerAttr,
                    },
                    null,
                    2,
                ) + '\n',
            )
        assert.equal(hash(owned(f.state())), before)
        f.call('TrialGroupChange', { open: false, trial_id: 3 })
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        const again = checkAbi(f, f.call('TrialGroupChange', { open: true, trial_id: 3 }))
        assert.equal(again.pet.guid, first.pet.guid)
        assert.deepEqual(again.pet.comprehension, first.pet.comprehension)
        assert.equal(hash(owned(f.state())), before)
    } finally {
        f.store.close()
    }
})

test('repair replaces legacy flat aptitude and wrong fixedDNA/skills; customized species wins over obsolete interim species', () => {
    const f = fixture('repair')
    try {
        f.call('TrialGroupChange', { open: true, trial_id: 3 })
        f.edit((s) => {
            const p = s.trialGroup.pets[0]
            p.comprehension = [{ attr_id: 1, value: 100, level: 1 }]
            p.gene_infos = []
            p.inherent_skills = []
        })
        const before = hash(owned(f.state()))
        f.edit((s) => assert.equal(repairTrialActorGuids(tables, s), true))
        checkAbi(f, f.call('TrialGroupChange', { open: true, trial_id: 3 }))
        assert.equal(hash(owned(f.state())), before)
        const current = hydrateTrialPet(tables, 621401, guid(621401)),
            old = {
                ...current,
                config_id: tables.find('pet_interim', 621401).petId,
                pet_name: Buffer.from('old species').toString('base64'),
            }
        const fixed = hydrateTrialPet(tables, 621401, guid(621401), old)
        assert.equal(fixed.config_id, tables.find('pet_customized', 621401).petId)
        assert.notEqual(fixed.config_id, old.config_id)
        assert.notEqual(fixed.pet_name, old.pet_name)
    } finally {
        f.store.close()
    }
})

test('codec and SQL failures roll back full group3 hydration; valid retries create one temporary pet without paid/owned mutation', () => {
    for (const mode of ['codec', 'sql']) {
        const f = fixture('rollback-' + mode)
        try {
            const before = f.saved(),
                encode = f.protocol.encode
            if (mode === 'codec')
                f.protocol.encode = function (name, ...args) {
                    if (name.replace(/^cs\./, '') === 'CSTrialDatas') throw Error('injected trial codec')
                    return encode.call(this, name, ...args)
                }
            else
                f.store.db.exec(
                    "CREATE TEMP TRIGGER trial_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'injected trial SQL'); END",
                )
            try {
                assert.throws(() => f.call('TrialGroupChange', { open: true, trial_id: 3 }), /injected trial/)
            } finally {
                f.protocol.encode = encode
                if (mode === 'sql') f.store.db.exec('DROP TRIGGER trial_fail')
            }
            assert.deepEqual(f.saved(), before)
            checkAbi(f, f.call('TrialGroupChange', { open: true, trial_id: 3 }))
            assert.equal(f.state().trialGroup.pets.length, 1)
        } finally {
            f.store.close()
        }
    }
})

test('missing current template/aptitude/skill configuration remains strict and owned profiles cannot be reclassified', () => {
    const missing = 0xffffff
    assert.equal(tables.find('pet_customized', missing), undefined)
    assert.throws(() => hydrateTrialPet(tables, missing, guid(missing)), { code: ErrorCode.TrialPetNotExist })
    const ownedPet = seedPlayer(tables, 1, 'owned-negative').pets[0],
        before = hash(ownedPet)
    assert.throws(() => hydrateTrialPet(tables, 102, guid(102), ownedPet), { code: ErrorCode.GameConfig })
    assert.equal(hash(ownedPet), before)
    for (const patch of [{ petAttr: '1#5' }, { breakSkillList: '601#99999999' }]) {
        const changed = new Tables(cfg.tables)
        changed.cache.set(
            'pet_customized',
            tables.get('pet_customized').map((r) => (r.id === 102 ? { ...r, ...patch } : r)),
        )
        assert.throws(() => hydrateTrialPet(changed, 102, guid(102)), { code: ErrorCode.GameConfig })
    }
    assert.throws(() => hydrateTrialPet(tables, 102, ((6n << 56n) | (102n << 32n) | 1n).toString()), {
        code: ErrorCode.GameConfig,
    })
})

test('current Lua consumes trial customized levels/skills and authoritative server attributes', () => {
    const luaRoot = path.resolve(cfg.tables, '../Lua/src/src'),
        lua = fs.readFileSync(path.join(luaRoot, 'ui/store/pet/petState.lua'), 'utf8'),
        action = fs.readFileSync(path.join(luaRoot, 'ui/store/pet/petAction.lua'), 'utf8')
    assert(lua.includes('petData:getIsTrial() and csPetData and csPetData.hasServerAttr and csPetData.attrDict'))
    assert(action.includes('local trialId = C_DataUtil.GetUuid2ConfigId(data[i].guid)'))
    assert(action.includes('local tpl_trial = petCustomizedTpl:getTplById(trialId)'))
    assert(action.includes('_appendTrialSkillFromDict(skills, breakSkillList)'))
})
