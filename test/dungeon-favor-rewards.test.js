import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { dungeonEntryFavorCandidates } from '../src/dungeon-favor-entry.js'
import { heroFavorabilityPlan } from '../src/hero-favorability.js'
import { ErrorCode } from '../src/error-codes.js'

const global4 = (f) => f.state().player.attr_infos.attrs.find((row) => row.attr_id === 4)?.attr_val
const hero = (f, id) => f.state().player.heros_info.heros.find((row) => row.guid === id)
function fixture(name, filename) {
    const f = repeatFixture(name, filename)
    if (!f.state().entrust?.run)
        f.store.transact(f.session.id, 0, (s) => {
            const heroes = s.player.heros_info.heros,
                main = heroes.find((row) => row.type === 1),
                eligible = heroes.filter((row) => f.tables.find('hero', row.conf_id)?.favor === 1).slice(0, 4)
            assert.equal(eligible.length, 4)
            const manager = s.player.group_mgrs.find((row) => row.type === 1)
            manager.cur_group = 1
            for (const [id, members] of [
                [1, [main, ...eligible.slice(0, 2)]],
                [2, [main, ...eligible.slice(2, 4)]],
            ]) {
                const group = manager.groups.find((row) => row.id === id)
                group.heros = members.map((h) => {
                    h.pet_id = '0'
                    h.favorability_lv = 1
                    h.favorability_exp = 0
                    h.store_favor_rewards = []
                    return { hero_id: h.guid, pet_id: '0' }
                })
                group.control = main.guid
            }
            s.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '1000'
            let attr = s.player.attr_infos.attrs.find((row) => row.attr_id === 4)
            if (!attr) s.player.attr_infos.attrs.push((attr = { attr_id: 4, attr_val: '0' }))
            attr.attr_val = '2850'
        })
    const recipients = () =>
        f
            .state()
            .entrust.run.favor_entry.members.filter((row) => row.favor_eligible)
            .map((row) => row.hero_guid)
    const enter = (kind = 'material', id = 30101) =>
        kind === 'material'
            ? f.call('MultiCampaignCreate', {
                  dungeon_id: f.tables.find('dungeon_material', id).dungeonId,
                  scene_type: 12,
              })
            : f.call('EnterEntrust', { entrust_id: id })
    const clear = () => {
        f.call('MultiCampaignPlayerLoadFinish')
        const stages = getEntrustCatalog(f.tables).stages(f.state().entrust.run.entrust_id)
        f.interact(stages[0].row.id)
        for (const stage of stages.filter((row) => row.type === 50)) f.kill(stage.row.id)
        assert(f.state().entrust.run.battle_complete)
    }
    const claim = (times = 1) =>
        f.call('StaminaBoxGet', {
            box_id: getEntrustCatalog(f.tables).chest(f.state().entrust.run.entrust_id).id,
            times,
        })
    return { ...f, enter, clear, claim, recipients }
}
const receipt = (f) => Object.values(f.state().entrust.run.dungeon_favor_receipts ?? {})[0]
function assertWire(f, packets, record) {
    const heroes = packets
        .filter((p) => p.id === 5008)
        .flatMap((p) => f.protocol.decode(f.protocol.byId.get(5008).rsp, p.payload).heros_info?.heros ?? [])
    for (const row of record.heroes) {
        const wire = heroes.find((h) => h.guid === row.hero_guid)
        assert(wire)
        assert.equal(wire.favorability_lv, row.after_lv)
        assert.equal(wire.favorability_exp, row.after_exp)
    }
}

test('type12 material keeps actual entry recipients across allowed team changes and sends their personal5008', () => {
    const f = fixture('material-entry-favor')
    try {
        f.enter()
        const saved = structuredClone(f.state().entrust.run.favor_entry),
            ids = f.recipients()
        assert.equal(f.tables.find('world_city', f.state().world.map_id).type, 12)
        assert.equal(ids.length, 2)
        f.clear()
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        assert.equal(f.state().player.group_mgrs.find((row) => row.type === 1).cur_group, 2)
        const before = structuredClone(f.state()),
            packets = f.claim(),
            r = receipt(f)
        assert.deepEqual(f.state().entrust.run.favor_entry, saved)
        assert.equal(r.amount, 200)
        assert.deepEqual(
            r.heroes.map((row) => row.hero_guid),
            ids,
        )
        for (const id of ids) {
            const p = heroFavorabilityPlan(f.tables, before, id, 200)
            assert.equal(hero(f, id).favorability_exp, p.exp)
        }
        const outsiders = f
            .state()
            .player.group_mgrs.find((row) => row.type === 1)
            .groups.find((row) => row.id === 2)
            .heros.slice(1)
        for (const row of outsiders) assert.equal(hero(f, row.hero_id).favorability_exp, 0)
        assert.equal(global4(f), '2850')
        assertWire(f, packets, r)
        const stable = structuredClone(f.state())
        f.claim()
        assert.deepEqual(f.state().entrust.run.dungeon_favor_receipts, stable.entrust.run.dungeon_favor_receipts)
    } finally {
        f.store.close()
    }
})

test('commission entry and multiplier use the same explicit personal reward helper, including direct object interaction', () => {
    const f = fixture('entrust-entry-favor')
    try {
        f.enter('entrust', 1)
        f.clear()
        const ids = f.recipients(),
            packets = f.claim(3),
            r = receipt(f)
        assert.equal(r.amount, 450)
        for (const id of ids) assert.equal(hero(f, id).favorability_exp, 450)
        assertWire(f, packets, r)
        assert.equal(global4(f), '2850')
        f.call('CampaignQuit')
        f.enter('entrust', 1)
        f.clear()
        const chest = getEntrustCatalog(f.tables).stages(1).at(-1).row.id
        f.interact(chest)
        assert.equal(receipt(f).amount, 150)
        for (const id of f.recipients()) assert.equal(hero(f, id).favorability_exp, 600)
        assert.equal(global4(f), '2850')
    } finally {
        f.store.close()
    }
})

test('old material and commission runs reject before costs or receipts and can quit and make a genuine fresh entry', () => {
    for (const kind of ['material', 'entrust']) {
        const f = fixture('legacy-entry-favor-' + kind)
        try {
            f.enter(kind, kind === 'material' ? 30101 : 1)
            f.clear()
            f.store.transact(f.session.id, 0, (s) => {
                delete s.entrust.run.favor_entry
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.claim(3),
                (e) => e.code === ErrorCode.FunctionClosed,
            )
            assert.deepEqual(f.state(), before)
            f.call('CampaignQuit')
            f.enter(kind, kind === 'material' ? 30101 : 1)
            f.clear()
            f.claim()
            assert(receipt(f))
            assert.equal(global4(f), '2850')
        } finally {
            f.store.close()
        }
    }
})

test('entry snapshot is never reconstructed on login, loading callbacks, formation switches or repeated scene entry', () => {
    const f = fixture('entry-favor-no-rebuild')
    try {
        f.enter()
        const before = structuredClone(f.state().entrust.run.favor_entry)
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        f.call('EnterDungeonScene', { scene_id: f.state().world.map_id })
        assert.deepEqual(f.state().entrust.run.favor_entry, before)
        f.call('EnterGame', { open_id: 'entry-favor-no-rebuild' }, {})
        assert.deepEqual(f.state().entrust.run.favor_entry, before)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.entrust.run.favor_entry
        })
        f.call('EnterGame', { open_id: 'entry-favor-no-rebuild' }, {})
        assert.equal(f.state().entrust.run.favor_entry, undefined)
        assert.equal(dungeonEntryFavorCandidates(f.tables, f.state()).status, 'legacy-entry-unverified')
    } finally {
        f.store.close()
    }
})

test('entry identity and qualification changes differ from missing owned hero and all reject before spending', () => {
    const f = fixture('entry-favor-identities')
    try {
        f.enter()
        f.clear()
        const original = structuredClone(f.state()),
            id = f.recipients()[0]
        for (const [mode, code] of [
            ['deleted', ErrorCode.HeroNotExist],
            ['identity', ErrorCode.GameConfig],
            ['trial', ErrorCode.HeroFavorExpLocked],
            ['broken-trial', ErrorCode.GameConfig],
            ['owner', ErrorCode.GameConfig],
            ['instance', ErrorCode.GameConfig],
        ]) {
            f.store.transact(f.session.id, 0, (s) => {
                const h = s.player.heros_info.heros.find((row) => row.guid === id)
                if (mode === 'deleted')
                    s.player.heros_info.heros = s.player.heros_info.heros.filter((row) => row.guid !== id)
                if (mode === 'identity') h.conf_id = 101007
                if (mode === 'trial') h.trail = true
                if (mode === 'broken-trial') h.trail = 'false'
                if (mode === 'owner') s.entrust.run.favor_entry.owner_id++
                if (mode === 'instance') s.entrust.run.favor_entry.instance_id++
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.claim(),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
            f.store.transact(f.session.id, 0, (s) => {
                for (const key of Object.keys(s)) delete s[key]
                Object.assign(s, structuredClone(original))
            })
        }
        const config = f.tables.find('hero', hero(f, id).conf_id),
            favor = config.favor
        config.favor = 0
        try {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.claim(),
                (e) => e.code === ErrorCode.HeroFavorExpLocked,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            config.favor = favor
        }
    } finally {
        f.store.close()
    }
})

test('personal cap and receipt amounts match5008 and transaction encoding failures roll back heroes, cost and box', () => {
    const f = fixture('entry-favor-atomic')
    try {
        f.enter()
        f.clear()
        const ids = f.recipients()
        f.store.transact(f.session.id, 0, (s) => {
            const a = s.player.heros_info.heros.find((h) => h.guid === ids[0]),
                b = s.player.heros_info.heros.find((h) => h.guid === ids[1])
            a.favorability_lv = 9
            a.favorability_exp = 15950
            b.favorability_lv = 10
            b.favorability_exp = 0
        })
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        for (const id of [5008, 9974]) {
            f.protocol.encode = (type, data) => {
                if (type === f.protocol.byId.get(id).rsp) throw Error('dungeon favor wire')
                return encode(type, data)
            }
            assert.throws(() => f.claim(3), /dungeon favor wire/)
            assert.deepEqual(f.state(), before)
        }
        f.protocol.encode = encode
        const packets = f.claim(3),
            r = receipt(f)
        assert.deepEqual(
            r.heroes.map((h) => [h.applied, h.capped]),
            [
                [50, 550],
                [0, 600],
            ],
        )
        assertWire(f, packets, r)
        assert.equal(global4(f), '2850')
    } finally {
        f.store.close()
    }
})

test('a failed entry packet does not save or consume an entry snapshot and next retry captures the actual team', () => {
    const f = fixture('entry-favor-entry-codec')
    try {
        const original = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        const create = f.protocol.byName.get('CSProtoMultiCampaignCreate'),
            handler = f.game.handlers.get(create.id)
        let draft
        f.game.handlers.set(create.id, (c, request) => {
            draft = c.state
            return handler(c, request)
        })
        f.protocol.encode = (type, data) => {
            //9510 itself has no response. Fail the real battle push emitted
            //after startEntrust captures the private entry snapshot.
            if (type === f.protocol.byName.get('CSProtoHeroAttrInfoSync').rsp && draft?.entrust?.run?.favor_entry)
                throw Error('entry wire')
            return encode(type, data)
        }
        assert.throws(() => f.enter(), /entry wire/)
        assert.deepEqual(f.state(), original)
        f.protocol.encode = encode
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        f.enter()
        assert.equal(f.state().entrust.run.favor_entry.group_id, 2)
        assert.equal(f.state().entrust.run.favor_entry.instance_id, 1)
    } finally {
        f.store.close()
    }
})

test('SQLite close/reopen retains the true entry team and receipts even when the current team differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-dungeon-favor-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('dungeon-favor-sqlite', file)
    try {
        f.enter()
        f.clear()
        const ids = f.recipients()
        f.call('SwitchWorldGroup', { type: 1, group_id: 2 })
        const entry = structuredClone(f.state().entrust.run.favor_entry)
        f.store.close()
        f = fixture('dungeon-favor-sqlite', file)
        assert.deepEqual(f.state().entrust.run.favor_entry, entry)
        f.claim()
        const r = structuredClone(receipt(f))
        f.store.close()
        f = fixture('dungeon-favor-sqlite', file)
        f.claim()
        assert.deepEqual(receipt(f), r)
        for (const id of ids) assert.equal(hero(f, id).favorability_exp, 200)
        assert.equal(global4(f), '2850')
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})
test('the material3580 family uses its table150 share rather than the200 accessory amount', () => {
    const f = fixture('material-family-favor')
    try {
        f.enter('material', 10101)
        f.clear()
        const before = BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val)
        f.claim(2)
        assert.equal(receipt(f).amount, 300)
        for (const id of f.recipients()) assert.equal(hero(f, id).favorability_exp, 300)
        assert.equal(BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val), before - 60n)
        assert.equal(global4(f), '2850')
    } finally {
        f.store.close()
    }
})

test('entry temporary members remain ineligible after their flags change and are not retroactively added to recipients', () => {
    const f = fixture('material-temporary-entry-favor')
    try {
        let id
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.player.group_mgrs.find((row) => row.type === 1).groups.find((row) => row.id === 1)
            id = g.heros[1].hero_id
            s.player.heros_info.heros.find((row) => row.guid === id).trail = true
        })
        f.enter()
        const member = f.state().entrust.run.favor_entry.members.find((row) => row.hero_guid === id)
        assert.equal(member.owned, false)
        assert.equal(member.favor_eligible, false)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros.find((row) => row.guid === id).trail = false
        })
        f.clear()
        f.claim()
        assert.equal(receipt(f).heroes.length, 1)
        assert.equal(hero(f, id).favorability_exp, 0)
        assert.equal(global4(f), '2850')
    } finally {
        f.store.close()
    }
})
