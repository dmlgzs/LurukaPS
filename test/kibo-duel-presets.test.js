import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { selectedArenaGroup, petInActiveNpcDuel } from '../src/npc-kibo-duel.js'
import { taskResourcePlan } from '../src/task-resource-consumption.js'
import { arenaAttributePayload } from '../src/handlers/kibo-duel.js'
import { editDuelPreset } from '../src/kibo-duel-presets.js'
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1792680000 })
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'duel-preset' })
    }
    login()
    return {
        store,
        call,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        saved: () => JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state),
    }
}
const skills = [
    { skill_id: 19999901, skill_lv: 1, skill_slot: 701, type: 1 },
    { skill_id: 19999902, skill_lv: 1, skill_slot: 702, type: 1 },
]
function group(f, slot = 1, petCount = 3) {
    const s = f.state()
    return {
        slot,
        duel_id: 2,
        index: 0,
        hero: s.player.heros_info.heros[0].guid,
        pet_guids: s.pets.slice(0, petCount).map((p) => ({ id: p.guid, is_trial: false })),
        hero_skills: skills,
    }
}
function sync(packets) {
    const e = protocol.byName.get('CSProtoKiboDuelGroupInfoSync'),
        packet = packets.find((p) => p.id === e.id)
    assert.ok(packet)
    return protocol.decode(e.rsp, packet.payload)
}
test('10741 persists owned-pet presets with real empty slots and publishes 10740 before ACK without changing ordinary or arena managers', () => {
    const f = setup()
    try {
        const original = f.state().player.group_mgrs,
            req = group(f),
            packets = f.call('KiboDuelGroupInfoChange', req),
            saved = f.state().kiboDuelGroups[1]
        assert.equal(saved.pet_guids.length, 8)
        assert.deepEqual(
            saved.pet_guids.slice(0, 3).map((p) => p.id),
            req.pet_guids.map((p) => p.id),
        )
        assert.ok(saved.pet_guids.slice(3).every((p) => p.id === '0' && p.guid === '0'))
        assert.deepEqual(f.state().player.group_mgrs, original)
        const push = packets.findIndex((p) => p.id === 10740),
            ack = packets.findIndex((p) => p.id === 10741)
        assert.ok(push >= 0 && ack >= 0 && push < ack)
        assert.equal(sync(packets).groups.filter((g) => g.slot >= 1 && g.slot <= 5).length, 5)
        f.store.flushPending()
        assert.deepEqual(f.saved().kiboDuelGroups[1], saved)
        f.login()
        assert.deepEqual(f.state().kiboDuelGroups[1], saved)
    } finally {
        f.store.close()
    }
})
test('clearing a preset keeps hero, skill and pet slots empty instead of borrowing world characters', () => {
    const f = setup()
    try {
        f.call('KiboDuelGroupInfoChange', { slot: 3, duel_id: 0, hero: '0', pet_guids: [], hero_skills: [] })
        const g = f.state().kiboDuelGroups[3]
        assert.equal(g.hero, '0')
        assert.deepEqual(g.hero_skills, [])
        assert.equal(g.pet_guids.length, 8)
        assert.ok(g.pet_guids.every((p) => p.id === '0'))
    } finally {
        f.store.close()
    }
})
test('duplicate owned instance is forbidden while distinct owned instances of the same species follow the current table switch', () => {
    const f = setup()
    try {
        const req = group(f),
            pet = req.pet_guids[0]
        let before = f.state()
        assert.throws(
            () => f.call('KiboDuelGroupInfoChange', { ...req, pet_guids: [pet, pet] }),
            (e) => e.code === ErrorCode.KiboDuelGroupSamePet,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.pets.push({ ...s.pets[0], guid: '900000001' })
        })
        f.call('KiboDuelGroupInfoChange', { ...req, pet_guids: [pet, { id: '900000001' }] })
        assert.equal(f.state().kiboDuelGroups[1].pet_guids.filter((p) => p.id !== '0').length, 2)
        const proxy = Object.create(tables)
        proxy.get = (name) =>
            name === 'game'
                ? tables.get(name).map((r) => (r.title === 'KIBO_DUEL_SAME_ID_PET_ALLOW' ? { ...r, value: '0' } : r))
                : tables.get(name)
        assert.throws(
            () =>
                editDuelPreset(
                    { state: f.state(), tables: proxy },
                    { ...req, pet_guids: [pet, { id: '900000001' }] },
                    () => {},
                ),
            (e) => e.code === ErrorCode.KiboDuelGroupSamePetId,
        )
    } finally {
        f.store.close()
    }
})
test('explicit uint64 guid disambiguates the managed sender truncated id and an id alone never selects by low bits', () => {
    const f = setup()
    try {
        const wide = '144115188075855873'
        f.edit((s) => s.pets.push({ ...s.pets[0], guid: wide }))
        const req = { ...group(f), pet_guids: [{ id: '1', guid: wide }] }
        f.call('KiboDuelGroupInfoChange', req)
        assert.equal(f.state().kiboDuelGroups[1].pet_guids[0].guid, wide)
        const before = f.state()
        assert.throws(
            () => f.call('KiboDuelGroupInfoChange', { ...req, pet_guids: [{ id: '1' }] }),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('invalid preset, unknown pets, excess pets, duplicate skills and out-of-pool skill metadata roll back the whole edit', () => {
    const f = setup()
    try {
        const req = group(f)
        for (const slot of [-1, 1.5, NaN, undefined]) {
            const before = f.state()
            assert.throws(
                () =>
                    editDuelPreset({ tables, state: before }, { ...req, slot }, () => assert.fail('must not publish')),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(f.state(), before)
        }
        for (const [bad, code] of [
            [{ ...req, slot: 0 }, ErrorCode.InvalidArgument],
            [{ ...req, slot: 6 }, ErrorCode.KiboDuelGroupExceedMaxNum],
            [{ ...req, slot: 98 }, ErrorCode.KiboDuelCurGroupNotSet],
            [{ ...req, pet_guids: [{ id: '999999999' }] }, ErrorCode.PetNotExist],
            [{ ...req, pet_guids: Array.from({ length: 9 }, () => ({})) }, ErrorCode.KiboDuelGroupPetExceedMaxNum],
            [{ ...req, hero_skills: [skills[0], { ...skills[0], skill_slot: 702 }] }, ErrorCode.KiboDuelSameHeroSkill],
            [{ ...req, hero_skills: [{ ...skills[0], skill_id: 12345678 }] }, ErrorCode.KiboDuelSkillNotExist],
            [{ ...req, hero_skills: [{ ...skills[0], skill_lv: 99 }] }, ErrorCode.InvalidArgument],
            [{ ...req, pet_guids: [{ id: '10383', is_trial: true }] }, ErrorCode.LKiboDuelOnlyPlayerPet],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('KiboDuelGroupInfoChange', bad),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('borrowed pets stay bound to their prepared 98 duel and fixed prefix cannot be replaced', () => {
    const f = setup()
    try {
        f.call('KiboDuelGetGroup', { u32: 501 })
        const prepared = f.state().kiboDuelGroups[98]
        assert.equal(prepared.duel_id, 501)
        f.call('KiboDuelGroupInfoChange', prepared)
        const bad = structuredClone(prepared)
        bad.pet_guids[0] = prepared.pet_guids[1]
        const before = f.state()
        assert.throws(() => f.call('KiboDuelGroupInfoChange', bad))
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => f.call('KiboDuelGroupInfoChange', { ...prepared, index: 0 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('editing the preset used by an active NPC duel preserves its formation snapshot, trainer skills and actor roster', () => {
    const f = setup()
    try {
        const req = group(f, 1, 8)
        f.call('KiboDuelGroupInfoChange', req)
        f.call('SetKiboDuelCurGroup', { type: 6, cur_group: 1 })
        f.call('MultiCampaignCreate', { dungeon_id: 40001 })
        const before = f.state(),
            run = before.combat.npcDuel
        assert.equal(run.formation_snapshot.pet_guids.filter((p) => p.id !== '0').length, 8)
        f.call('KiboDuelGroupInfoChange', { ...req, hero: '0', hero_skills: [], pet_guids: [req.pet_guids[0]] })
        const after = f.state()
        assert.equal(after.kiboDuelGroups[1].hero, '0')
        assert.deepEqual(after.combat.npcDuel.formation_snapshot, run.formation_snapshot)
        assert.deepEqual(after.combat.npcDuel.actors, run.actors)
        assert.deepEqual(after.combat.npcDuel.trainer_skill_infos, run.trainer_skill_infos)
        assert.equal(selectedArenaGroup(after).hero, req.hero)
        assert.equal(arenaAttributePayload(tables, after).infos.length, 8)
        const removed = req.pet_guids[7].id
        assert.equal(petInActiveNpcDuel(after, removed), true)
        assert.throws(
            () => f.call('DelPet', { pet_list: [removed] }),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        const source = after.pets.find((p) => p.guid === removed)
        assert.throws(
            () =>
                taskResourcePlan({ tables, state: after }, [
                    {
                        item_type: 5,
                        item_id: source.config_id,
                        item_guid: removed,
                        item_count: 1,
                    },
                ]),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        assert.deepEqual(f.state(), after)
        const left = structuredClone(after)
        delete left.multiCampaign
        assert.equal(petInActiveNpcDuel(left, removed), false)
        // Legacy active runs without a snapshot retain the actor source guard.
        delete after.combat.npcDuel.formation_snapshot
        assert.equal(petInActiveNpcDuel(after, removed), true)
    } finally {
        f.store.close()
    }
})
test('a failed 10740 encoding restores the prior preset and formation snapshot', () => {
    const f = setup()
    try {
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoKiboDuelGroupInfoSync').rsp)
                throw Error('preset sync codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('KiboDuelGroupInfoChange', group(f)), /codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
