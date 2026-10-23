import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { heroFavorabilityPlan } from '../src/hero-favorability.js'
import { grantRewards } from '../src/rewards.js'
import { repeatFavorRewardContext } from '../src/hero-favor-rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/hero-favor-reward-policy.json' with { type: 'json' }

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
const attr4 = (s) => s.player.attr_infos.attrs.find((row) => row.attr_id === 4)?.attr_val
const actor = (f, id) => f.state().player.heros_info.heros.find((hero) => hero.guid === id)
function fixture(name, filename) {
    const f = repeatFixture(name, filename)
    if (!f.state().entrust?.run)
        f.store.transact(f.session.id, 0, (s) => {
            const all = s.player.heros_info.heros,
                main = all.find((hero) => hero.type === 1),
                others = all.filter((hero) => f.tables.find('hero', hero.conf_id)?.favor === 1).slice(0, 2)
            assert.equal(others.length, 2)
            const group = s.player.group_mgrs.find((row) => row.type === 1).groups.find((row) => row.id === 1)
            s.player.group_mgrs.find((row) => row.type === 1).cur_group = 1
            group.heros = [main, ...others].map((hero) => {
                hero.pet_id = '0'
                hero.favorability_lv = 1
                hero.favorability_exp = 0
                hero.store_favor_rewards = []
                return { hero_id: hero.guid, pet_id: '0' }
            })
            group.control = main.guid
            const attrs = s.player.attr_infos.attrs
            let old = attrs.find((row) => row.attr_id === 4)
            if (!old) attrs.push((old = { attr_id: 4, attr_val: '0' }))
            old.attr_val = '2850'
            attrs.find((row) => row.attr_id === 3).attr_val = '500'
        })
    return f
}
function clear(f, restart = false, level = 10101) {
    f.call(restart ? 'RepeatEventReEnterLevelReq' : 'RepeatEventEnterLevelReq', { ...request, level })
    f.call('MultiCampaignPlayerLoadFinish')
    const stages = getEntrustCatalog(f.tables).stages(f.state().entrust.run.dungeon_id)
    f.interact(stages[0].row.id)
    for (const stage of stages.slice(1, -1)) f.kill(stage.row.id)
    assert(f.state().entrust.run.battle_complete)
}
const receipts = (f) => Object.values(f.state().entrust.run.repeat_favor_receipts ?? {})
const ids = (f) =>
    f
        .state()
        .entrust.run.repeat_formation.slots.filter((s) => s.favor_eligible)
        .map((s) => s.hero_id)
function claim(f, times = 1) {
    return f.call('StaminaBoxGet', {
        box_id: getEntrustCatalog(f.tables).chest(f.state().entrust.run.entrust_id).id,
        times,
    })
}

test('user-selected each-v1 gives each qualified entry hero a full share, skips favor0 by table, publishes matching5008 and preserves legacy2850', () => {
    const f = fixture('repeat-each-personal')
    try {
        assert.equal(policy.allocation, 'entry-favor-roster-each-v1')
        clear(f)
        const eligible = ids(f),
            snapshot = f.state().entrust.run.repeat_formation,
            before = structuredClone(f.state())
        const packets = claim(f)
        const receipt = receipts(f).find((row) => row.operation === 'chest-base')
        assert(receipt.amount > 0)
        assert.equal(receipt.heroes.length, 2)
        assert.deepEqual(
            receipt.heroes.map((row) => row.hero_guid),
            eligible,
        )
        const syncs = packets
            .filter((p) => p.id === 5008)
            .map((p) => f.protocol.decode(f.protocol.byId.get(5008).rsp, p.payload))
        for (const id of eligible) {
            const expected = heroFavorabilityPlan(f.tables, before, id, receipt.amount)
            assert.equal(actor(f, id).favorability_exp, expected.exp)
            assert.equal(actor(f, id).favorability_lv, expected.level)
            assert.equal(receipt.heroes.find((row) => row.hero_guid === id).applied, receipt.amount)
            const wire = syncs.flatMap((data) => data.heros_info?.heros ?? []).find((hero) => hero.guid === id)
            assert(wire)
            assert.equal(wire.favorability_exp, expected.exp)
            assert.equal(wire.favorability_lv, expected.level)
        }
        const main = snapshot.slots.find((slot) => slot.hero_id !== '0' && !slot.favor_eligible).hero_id
        assert.deepEqual(
            actor(f, main),
            before.player.heros_info.heros.find((hero) => hero.guid === main),
        )
        assert.equal(attr4(f.state()), '2850')
        const after = structuredClone(f.state())
        claim(f)
        assert.deepEqual(f.state().entrust.run.repeat_favor_receipts, after.entrust.run.repeat_favor_receipts)
        for (const id of eligible)
            assert.deepEqual(
                actor(f, id),
                after.player.heros_info.heros.find((hero) => hero.guid === id),
            )
    } finally {
        f.store.close()
    }
})

test('multi-share free and paid rewards use their exact currency4 amount independently for each entry hero', () => {
    const f = fixture('repeat-each-multishare')
    try {
        clear(f)
        claim(f, 3)
        const first = receipts(f).find((row) => row.operation === 'chest-base')
        assert.equal(first.amount, 450)
        for (const id of ids(f)) assert.equal(actor(f, id).favorability_exp, 450)
        assert.equal(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val, '440')
        clear(f, true)
        claim(f, 2)
        assert.equal(receipts(f).find((row) => row.operation === 'chest-base').amount, 300)
        for (const id of ids(f)) assert.equal(actor(f, id).favorability_exp, 750)
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
    }
})

test('each personal cap is independent, receipt explains applied/capped and level rewards remain claimable', () => {
    const f = fixture('repeat-each-cap')
    try {
        clear(f)
        const eligible = ids(f)
        f.store.transact(f.session.id, 0, (s) => {
            const a = s.player.heros_info.heros.find((h) => h.guid === eligible[0]),
                b = s.player.heros_info.heros.find((h) => h.guid === eligible[1])
            a.favorability_lv = 9
            a.favorability_exp = 15950
            b.favorability_lv = 10
            b.favorability_exp = 0
        })
        const packets = claim(f)
        const rows = receipts(f).find((row) => row.operation === 'chest-base').heroes
        assert.deepEqual(
            rows.map((row) => [row.applied, row.capped]),
            [
                [50, 100],
                [0, 150],
            ],
        )
        assert.equal(actor(f, eligible[0]).favorability_lv, 10)
        assert.equal(actor(f, eligible[0]).favorability_exp, 0)
        assert(actor(f, eligible[0]).store_favor_rewards.length > 0)
        const wireHeroes = packets
            .filter((packet) => packet.id === 5008)
            .flatMap(
                (packet) => f.protocol.decode(f.protocol.byId.get(5008).rsp, packet.payload).heros_info?.heros ?? [],
            )
        for (const row of rows) {
            const wire = wireHeroes.find((hero) => hero.guid === row.hero_guid)
            assert(wire)
            assert.equal(wire.favorability_lv, row.after_lv)
            assert.equal(wire.favorability_exp, row.after_exp)
        }
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
    }
})

test('old run without verified entry rejects before costs, first-pass/random grant or receipts; it can still quit and reenter', () => {
    const f = fixture('repeat-each-legacy')
    try {
        clear(f)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.entrust.run.repeat_formation
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => claim(f, 3),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        f.call('CampaignQuit')
        clear(f)
        claim(f)
        assert.equal(receipts(f).length, 1)
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
    }
})

test('5008 or9974 encoding failures roll back all personal heroes, level receipts, currency and first/free/extra records', () => {
    const f = fixture('repeat-each-codec')
    try {
        clear(f)
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        for (const packet of [5008, 9974]) {
            f.protocol.encode = (type, data) => {
                if (type === f.protocol.byId.get(packet).rsp) throw Error('favor wire ' + packet)
                return encode(type, data)
            }
            assert.throws(() => claim(f, 3), /favor wire/)
            assert.deepEqual(f.state(), before)
        }
        f.protocol.encode = encode
        claim(f, 3)
        for (const id of ids(f)) assert.equal(actor(f, id).favorability_exp, 450)
        assert.equal(receipts(f).length, 1)
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
    }
})

test('personal entry receipts and owned progress survive complete SQLite reopen without reassigning to claim-time control', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-repeat-personal-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('repeat-each-sqlite', file)
    try {
        clear(f)
        const eligible = ids(f)
        f.call('SwitchWorldGroupControl', { type: 1, control: eligible[1] })
        f.call('SwitchGroupControlEnd', { uuid: eligible[1] })
        claim(f, 3)
        const records = structuredClone(receipts(f))
        f.store.close()
        f = fixture('repeat-each-sqlite', file)
        assert.deepEqual(receipts(f), records)
        claim(f, 3)
        for (const id of eligible) assert.equal(actor(f, id).favorability_exp, 450)
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})

test('all12 genuine clear/chest routes use entry personal rewards rather than the global attr4 mirror', () => {
    const f = fixture('repeat-each-twelve')
    try {
        let earned = 0
        for (let level = 10101; level <= 10112; level++) {
            clear(f, false, level)
            claim(f)
            const r = receipts(f).find((row) => row.operation === 'chest-base')
            assert(r && r.heroes.length === 2)
            earned += r.amount
            for (const row of r.heroes) assert.equal(row.applied, r.amount)
            assert.equal(attr4(f.state()), '2850')
            f.call('CampaignQuit')
        }
        assert.equal(earned, 1800)
        const group = f
            .state()
            .player.group_mgrs.find((row) => row.type === 1)
            .groups.find((row) => row.id === 1)
        for (const slot of group.heros.slice(1)) assert.equal(actor(f, slot.hero_id).favorability_exp, earned)
    } finally {
        f.store.close()
    }
})

test('shared explicit grant is receipt-idempotent and rejects changing recipient/amount, while unmigrated callers log their legacy gap', () => {
    const f = fixture('repeat-each-explicit')
    try {
        clear(f)
        f.store.transact(f.session.id, 0, (s) => {
            const ctx = () => ({ personalFavor: repeatFavorRewardContext(f.tables, s, 'explicit-audit') })
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 4, itemnum: 150 }], 0, ctx())
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 4, itemnum: 150 }], 0, ctx())
            assert.throws(
                () => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 4, itemnum: 151 }], 0, ctx()),
                (e) => e.code === ErrorCode.GameConfig,
            )
        })
        for (const id of ids(f)) assert.equal(actor(f, id).favorability_exp, 150)
        const warn = console.warn,
            logs = []
        console.warn = (value) => logs.push(JSON.parse(value))
        try {
            const outside = structuredClone(f.state())
            delete outside.entrust.run
            grantRewards(f.tables, outside, [{ itemtype: 10, itemid: 4, itemnum: 25 }])
            assert.equal(attr4(outside), '2875')
            assert.deepEqual(logs, [
                {
                    event: 'missing-favor-context',
                    amount: 25,
                    map_id: outside.world.map_id,
                    compatibility: 'legacy-global-unallocated',
                },
            ])
        } finally {
            console.warn = warn
        }
    } finally {
        f.store.close()
    }
})
test('damaged personal state or entry ownership fails before paid spending instead of diverting reward to another hero', () => {
    const f = fixture('repeat-each-bad-entry')
    try {
        clear(f)
        for (const corruption of ['bad-exp', 'trial', 'missing-hero', 'missing-snapshot']) {
            const original = structuredClone(f.state())
            f.store.transact(f.session.id, 0, (s) => {
                const id = s.entrust.run.repeat_formation.slots.find((slot) => slot.favor_eligible).hero_id
                const h = s.player.heros_info.heros.find((hero) => hero.guid === id)
                if (corruption === 'bad-exp') h.favorability_exp = -1
                if (corruption === 'trial') h.trail = true
                if (corruption === 'missing-hero')
                    s.player.heros_info.heros = s.player.heros_info.heros.filter((hero) => hero.guid !== id)
                if (corruption === 'missing-snapshot') delete s.entrust.run.repeat_formation
            })
            const bad = structuredClone(f.state())
            assert.throws(() => claim(f, 3))
            assert.deepEqual(f.state(), bad)
            f.store.transact(f.session.id, 0, (s) => {
                for (const key of Object.keys(s)) delete s[key]
                Object.assign(s, original)
            })
        }
    } finally {
        f.store.close()
    }
})
test('a verified entry containing only favor0 hero records an empty recipient receipt and never falls back to global currency4', () => {
    const f = fixture('repeat-each-no-eligible')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const manager = s.player.group_mgrs.find((row) => row.type === 1),
                group = manager.groups.find((row) => row.id === manager.cur_group)
            group.heros = [group.heros[0]]
        })
        clear(f)
        assert.deepEqual(ids(f), [])
        claim(f)
        const receipt = receipts(f).find((row) => row.operation === 'chest-base')
        assert.equal(receipt.amount, 150)
        assert.deepEqual(receipt.heroes, [])
        assert.equal(attr4(f.state()), '2850')
    } finally {
        f.store.close()
    }
})
