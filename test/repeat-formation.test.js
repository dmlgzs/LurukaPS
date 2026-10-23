import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { repeatFormationIsLocked, repeatEntryFavorCandidates } from '../src/repeat-formation.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
function fixture(name, filename = ':memory:') {
    const f = ornamentFixture(name, { filename })
    if (!f.state().entrust?.run)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 45
            ;(s.taskRecords ??= []).push({ task_id: 106015, count: 1 })
            const heroes = s.player.heros_info.heros,
                main = heroes.find((hero) => hero.type === 1)
            const eligible = heroes.filter((hero) => f.tables.find('hero', hero.conf_id)?.favor === 1).slice(0, 3)
            const selected = [main, ...eligible.slice(0, 2)],
                pets = s.pets.slice(0, 3)
            const manager = s.player.group_mgrs.find((manager) => manager.type === 1),
                group = manager.groups.find((group) => group.id === 1)
            manager.cur_group = 1
            group.heros = selected.map((hero, index) => {
                const pet = index === 0 ? null : pets[index - 1]
                hero.pet_id = pet?.guid ?? '0'
                if (pet) pet.hero_id = hero.guid
                return { hero_id: hero.guid, pet_id: pet?.guid ?? '0' }
            })
            group.control = main.guid
            const other = manager.groups.find((group) => group.id === 2)
            other.heros = [{ hero_id: eligible[2].guid, pet_id: '0' }]
            other.control = eligible[2].guid
        })
    const manager = () => f.state().player.group_mgrs.find((manager) => manager.type === 1)
    return { ...f, manager }
}
const stable = (f) => f.state().entrust.run.repeat_formation
const expectBlocked = (f, name, data) => {
    const before = structuredClone(f.state())
    assert.throws(
        () => f.call(name, data),
        (e) => e.code === ErrorCode.InDungeon,
    )
    assert.deepEqual(f.state(), before)
}

test('repeat type2 captures real owned GUID and pet bindings after entry, with main hero ineligible by the current hero table', () => {
    const f = fixture('repeat-roster-entry')
    try {
        const expected = structuredClone(f.manager().groups.find((group) => group.id === 1).heros)
        f.call('RepeatEventEnterLevelReq', request)
        const saved = stable(f)
        assert.equal(saved.version, 1)
        assert.equal(saved.source, 'verified-entry')
        assert.equal(saved.instance_id, f.state().entrust.run.instance_id)
        assert.deepEqual(
            saved.slots.map(({ hero_id, pet_id }) => ({ hero_id, pet_id })),
            expected,
        )
        assert(saved.slots.every((slot) => BigInt(slot.hero_id) > BigInt(Number.MAX_SAFE_INTEGER)))
        assert.equal(saved.slots[0].favor_eligible, false)
        assert.deepEqual(
            saved.slots.slice(1).map((slot) => slot.favor_eligible),
            [true, true],
        )
        assert.equal(repeatFormationIsLocked(f.tables, f.state()), true)
        assert.deepEqual(
            repeatEntryFavorCandidates(f.tables, f.state()).hero_guids,
            expected.slice(1).map((slot) => slot.hero_id),
        )
    } finally {
        f.store.close()
    }
})
test('5980,5981 and5982 cannot replace or reorder the active repeat roster and every rejected change rolls back', () => {
    const f = fixture('repeat-roster-block')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const group = structuredClone(f.manager().groups.find((group) => group.id === 1))
        group.heros.reverse()
        expectBlocked(f, 'ChangeHeroGroupIndex', { type: 1, group })
        expectBlocked(f, 'QuickChangeGroupInfo', {
            type: 1,
            id: 1,
            infos: group.heros.map((slot) => ({ hero_guid: slot.hero_id, pet_guid: slot.pet_id })),
        })
        expectBlocked(f, 'SwitchWorldGroup', { type: 1, group_id: 2 })
    } finally {
        f.store.close()
    }
})
test('direct pet rebinding and indirect stealing through another saved team cannot change entry companions', () => {
    const f = fixture('repeat-pet-lock')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const protectedSlot = stable(f).slots[1],
            other = f.manager().groups.find((group) => group.id === 2).heros[0]
        const spare = f.state().pets.find((pet) => !stable(f).slots.some((slot) => slot.pet_id === pet.guid))
        expectBlocked(f, 'WearPet', { hero_guid: protectedSlot.hero_id, pet_guid: spare.guid })
        expectBlocked(f, 'WearPet', { hero_guid: other.hero_id, pet_guid: protectedSlot.pet_id })
        expectBlocked(f, 'QuickChangeGroupInfo', {
            type: 1,
            id: 2,
            infos: [{ hero_guid: other.hero_id, pet_guid: protectedSlot.pet_id }],
        })
    } finally {
        f.store.close()
    }
})
test('5983 battle control switches, control-end acknowledgments, names and unrelated saved-team edits remain usable', () => {
    const f = fixture('repeat-control-allowed')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const before = structuredClone(stable(f)),
            pos = structuredClone(f.state().world.pos),
            control = before.slots[1].hero_id
        f.call('SwitchWorldGroupControl', { type: 1, control })
        f.call('SwitchGroupControlEnd', { uuid: control })
        assert.equal(f.manager().groups.find((group) => group.id === 1).control, control)
        assert.equal(f.state().world.control_ready, control)
        assert.deepEqual(f.state().world.pos, pos)
        f.call('ChangeGroupName', { type: 1, group_id: 1, name: Buffer.from('副本队伍').toString('base64') })
        const other = structuredClone(f.manager().groups.find((group) => group.id === 2))
        f.call('ChangeHeroGroupIndex', { type: 1, group: other })
        assert.deepEqual(stable(f), before)
    } finally {
        f.store.close()
    }
})
test('outside repeat type2 the regular world and material type12 retain their existing formation behavior', () => {
    const f = fixture('repeat-lock-scope')
    try {
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        assert.equal(f.manager().cur_group, 2)
        f.call('SwitchWorldGroup', { type: 1, group_id: 1 })
        f.call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
        assert.equal(repeatFormationIsLocked(f.tables, f.state()), false)
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        assert.equal(f.manager().cur_group, 2)
    } finally {
        f.store.close()
    }
})
test('legacy active run never receives fabricated entry candidates, but rejects new member edits until a genuine reentry', () => {
    const f = fixture('repeat-lock-legacy')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.entrust.run.repeat_formation
        })
        f.reload()
        assert.equal(stable(f), undefined)
        assert.equal(repeatEntryFavorCandidates(f.tables, f.state()).status, 'legacy-entry-unverified')
        expectBlocked(f, 'SwitchWorldGroup', { type: 1, group_id: 2 })
        f.call('RepeatEventReEnterLevelReq', request)
        assert.equal(stable(f).source, 'verified-entry')
    } finally {
        f.store.close()
    }
})
test('entry snapshot creation rolls back when a later10500 packet fails to encode', () => {
    const f = fixture('repeat-lock-codec')
    try {
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(10500).rsp) throw Error('wire failure')
            return encode(type, data)
        }
        assert.throws(() => f.call('RepeatEventEnterLevelReq', request), /wire failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('RepeatEventEnterLevelReq', request)
        assert.equal(stable(f).instance_id, 1)
    } finally {
        f.store.close()
    }
})
test('SQLite preserves immutable entry candidates independently of current control and never substitutes a later team', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-repeat-roster-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('repeat-lock-sqlite', file)
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const before = structuredClone(stable(f)),
            candidates = repeatEntryFavorCandidates(f.tables, f.state())
        f.call('SwitchWorldGroupControl', { type: 1, control: before.slots[2].hero_id })
        f.store.close()
        f = fixture('repeat-lock-sqlite', file)
        assert.deepEqual(stable(f), before)
        assert.deepEqual(repeatEntryFavorCandidates(f.tables, f.state()), candidates)
        // A direct storage fixture change represents an external/old-server
        // edit. Candidate lookup must still use entry GUIDs rather than a new team.
        f.store.transact(f.session.id, 0, (s) => {
            s.player.group_mgrs.find((manager) => manager.type === 1).cur_group = 2
        })
        assert.deepEqual(repeatEntryFavorCandidates(f.tables, f.state()), candidates)
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})

test('entry snapshot follows the actual formation restored by worldSync rather than a stale home workaround team', () => {
    const f = fixture('repeat-lock-restoration')
    try {
        const expected = f.manager().groups.find((group) => group.id === 2).heros[0].hero_id
        f.store.transact(f.session.id, 0, (s) => {
            s.homeFormationBackup = structuredClone(s.player.group_mgrs.find((manager) => manager.type === 1))
            s.homeFormationBackup.cur_group = 2
        })
        f.call('RepeatEventEnterLevelReq', request)
        assert.equal(f.manager().cur_group, 2)
        assert.equal(stable(f).group_id, 2)
        assert.equal(stable(f).slots[0].hero_id, expected)
        assert.deepEqual(repeatEntryFavorCandidates(f.tables, f.state()).hero_guids, [expected])
        assert.equal(f.state().homeFormationBackup, undefined)
    } finally {
        f.store.close()
    }
})

test('a damaged old snapshot cannot trap the player by blocking the normal quit path', () => {
    const f = fixture('repeat-lock-damaged-exit')
    try {
        const destination = structuredClone(f.state().world)
        f.call('RepeatEventEnterLevelReq', request)
        f.store.transact(f.session.id, 0, (s) => {
            s.entrust.run.repeat_formation.version = 99
        })
        assert.throws(
            () => f.call('ChangeGroupName', { type: 1, group_id: 1, name: Buffer.from('无效').toString('base64') }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.entrust.run.repeat_formation.version = 1
            s.entrust.run.repeat_formation.slots[2] = { ...s.entrust.run.repeat_formation.slots[1] }
        })
        assert.throws(
            () => repeatEntryFavorCandidates(f.tables, f.state()),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.call('CampaignQuit')
        assert.equal(f.state().entrust.run, undefined)
        assert.equal(f.state().world.map_id, destination.map_id)
    } finally {
        f.store.close()
    }
})
