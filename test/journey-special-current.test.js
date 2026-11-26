import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, trustedClaimedPoints, selectionDefinition } from './journey-special-fixture.js'
import { journeyModel, journeyPoints } from '../src/journey.js'
import { journeySelectionSource, selectJourneySoulReward } from '../src/journey-selection-source.js'
import { ErrorCode } from '../src/error-codes.js'
const souls = (f) => f.state().player.soulessence_infos.soulessences
const stock = (f, id) =>
    f
        .state()
        .player.sbag_infos.items.filter((r) => r.itemid === id)
        .reduce((n, r) => n + r.itemnum, 0)
class CurrentSoulConsumer {
    owned = new Map()
    shown = 0
    consume(f, packets) {
        for (const p of packets) {
            const e = f.protocol.byId.get(p.id),
                v = e.rsp ? f.protocol.decode(e.rsp, p.payload) : {},
                data = p.id === 5001 ? v.data : p.id === 5008 ? v : null
            for (const s of data?.soulessence_infos?.soulessences ?? []) this.owned.set(String(s.guid), s)
            if (p.id === 11883)
                for (const r of v.rewards ?? []) {
                    assert(this.owned.has(r.guid), 'selection callback cannot precede the owned profile')
                    assert.equal(this.owned.get(r.guid).id, r.itemid)
                    this.shown += r.itemnum
                }
        }
    }
}
function compatible(f, definition) {
    const hero = f.state().player.heros_info.heros.find((h) => !h.trail),
        cfg = f.tables.find('hero', hero.conf_id),
        chosen = definition.choices.find((r) => f.tables.find('soulessence', r.itemid).validProfession === cfg.position)
    assert(chosen)
    return { hero, chosen }
}
test('strict current300 boundary, preserved physical box, unique profile and current rarity/base skill after real6046 equip', () => {
    const low = fixture('below-threshold')
    try {
        const def = selectionDefinition(low.tables),
            choice = def.choices[0]
        assert.equal(def.row.point, 300)
        trustedClaimedPoints(low, def.row.point - 1)
        const before = low.saved()
        assert.throws(() => low.call('JourneyReceiveSpecialReward', { u32s: [choice.itemid, choice.itemtype] }), {
            code: ErrorCode.JourneyContReward,
        })
        assert.deepEqual(low.saved(), before)
    } finally {
        low.close()
    }
    const f = fixture('current-threshold'),
        client = new CurrentSoulConsumer()
    try {
        client.consume(f, f.packets())
        const def = selectionDefinition(f.tables),
            { hero, chosen } = compatible(f, def)
        assert.equal(def.box.useType, 28)
        trustedClaimedPoints(f, def.row.point)
        f.gm(`item ${def.box.id} 1`)
        client.consume(f, f.packets())
        const before = souls(f).length,
            oldBox = stock(f, def.box.id)
        const reply = f.call('JourneyReceiveSpecialReward', { u32s: [chosen.itemid, chosen.itemtype] })
        client.consume(f, f.packets())
        assert.equal(reply.rewards.length, 1)
        const award = reply.rewards[0],
            profile = souls(f).find((r) => String(r.guid) === award.guid),
            cfg = f.tables.find('soulessence', chosen.itemid)
        assert(profile)
        assert.equal(profile.id, chosen.itemid)
        assert.equal(souls(f).length, before + 1)
        assert.deepEqual([profile.lv, profile.rank, profile.advance], [1, 1, 1])
        assert.equal(cfg.rarity, 4, 'use the current configured rarity, not the box description or legacy5')
        assert.equal(
            stock(f, def.box.id),
            oldBox,
            '11883 consumes entitlement only, not an independently owned definition box',
        )
        assert.equal(f.state().journey.pointMask, def.bit)
        const frames = f.packets(),
            ack = frames.findIndex((p) => p.id === 11883)
        assert(frames.findIndex((p) => p.id === 5008) >= 0 && frames.findIndex((p) => p.id === 5008) < ack)
        const held = f.state().journey.specialItem
        f.call('MoveSoulEssence', { hero_id: hero.guid, guid: profile.guid })
        const info = f.protocol
            .decode(f.protocol.byId.get(10006).rsp, f.packets().find((p) => p.id === 10006).payload)
            .heros.find((h) => h.hero_guid === hero.guid)
        assert(info)
        const module = info.modules.find((m) => m.module_type === 1).sub_modules[0]
        const expected = f.tables
            .get('soulessence_grade')
            .filter((r) => r.soulessenceId === profile.id && r.grade === 0)
            .sort((a, b) => a.subSkillId - b.subSkillId)
            .map((r) => [r.skillId, r.skillLv])
        assert(expected.length > 0)
        assert.deepEqual(
            module.skills.skills.map((s) => [s.skill_id, s.skill_lv]),
            expected,
        )
        assert(module.attrs.attrs.length > 0)
        const after = souls(f).length,
            next = f.state().nextEssenceGuid
        assert.deepEqual(f.call('JourneyReceiveSpecialReward', { u32s: [chosen.itemid, chosen.itemtype] }).rewards, [])
        assert.equal(souls(f).length, after)
        assert.equal(f.state().nextEssenceGuid, next)
        const cold = new CurrentSoulConsumer()
        cold.consume(f, f.login())
        assert(cold.owned.has(award.guid))
        assert.equal(cold.shown, 0)
        assert.deepEqual(f.state().journey.specialItem, held)
        assert.deepEqual(f.call('JourneyReceiveSpecialReward', { u32s: [chosen.itemid, chosen.itemtype] }).rewards, [])
        assert.equal(souls(f).length, after)
        const changed = def.choices.find((r) => r.itemid !== chosen.itemid),
            saved = f.saved()
        assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s: [changed.itemid, changed.itemtype] }), {
            code: ErrorCode.JourneyNoReward,
        })
        assert.deepEqual(f.saved(), saved)
    } finally {
        f.close()
    }
})
test('real public hero leveling and9869 claims earn actual points; no claimed/point injection is used for this path', () => {
    const f = fixture('real-earned-target')
    try {
        const initial = journeyPoints(journeyModel(f.tables), f.state())
        assert.equal(initial, 0)
        f.gm('level 20')
        f.gm('item 400003 1')
        f.gm('gold 10000')
        const hero = f.state().player.heros_info.heros[0],
            before = f
                .state()
                .player.sbag_infos.items.filter((i) => i.itemid === 400003)
                .reduce((n, r) => n + r.itemnum, 0)
        f.call('LvUpHero', { hero_id: hero.guid, items: [{ item_id: 400003, item_num: 1 }] })
        assert(f.state().player.heros_info.heros.find((h) => h.guid === hero.guid).hero_lv >= 20)
        assert.equal(
            f
                .state()
                .player.sbag_infos.items.filter((i) => i.itemid === 400003)
                .reduce((n, r) => n + r.itemnum, 0),
            before - 1,
        )
        const model = journeyModel(f.tables),
            target = model.targets.find(
                (r) =>
                    r.supported &&
                    model.owner.has(r.id) &&
                    r.tokens[0] === 13002 &&
                    r.tokens[1] === 20 &&
                    r.tokens[2] === 1,
            )
        assert(target)
        f.call('JourneyTaskFinish', { u32s: [model.owner.get(target.id)] })
        assert.equal(f.state().journey.targets[target.id].claimed, true)
        const points = journeyPoints(model, f.state())
        assert(points >= target.completePoint)
        f.call('JourneyTaskFinish', { u32s: [model.owner.get(target.id)] })
        assert.equal(journeyPoints(model, f.state()), points)
        const def = selectionDefinition(f.tables),
            choice = def.choices[0],
            saved = f.saved()
        assert(points < def.row.point, 'this validates an earning producer, not a natural300-point E2E')
        assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s: [choice.itemid, choice.itemtype] }), {
            code: ErrorCode.JourneyContReward,
        })
        assert.deepEqual(f.saved(), saved)
    } finally {
        f.close()
    }
})
test('current soul UI resolves its definition without imposing the bag useType router; request identity remains exact', () => {
    const f = fixture('source-definitions')
    try {
        const def = selectionDefinition(f.tables),
            row = { ...def.row, rewards: [{ itemtype: 3, itemid: def.box.id, itemnum: 1 }] },
            chosen = def.choices[0]
        const view = (patch) => ({
            find(name, id) {
                const found = f.tables.find(name, id)
                return name === 'common_item' && id === def.box.id ? { ...found, ...patch } : found
            },
        })
        // Only28 is a real current Journey FK. Other values are isolated views
        // proving that this UI reads the definition, not the bag-use router.
        for (const useType of [3, 26, 28, 29, 999, undefined]) {
            const tables = view({ useType }),
                source = journeySelectionSource(tables, row)
            assert.deepEqual(selectJourneySoulReward(tables, source, chosen.itemid, chosen.itemtype), chosen)
        }
        assert.throws(() => journeySelectionSource(view({ giftBagReward: '' }), row), {
            code: ErrorCode.JourneyConfError,
        })
        const source = journeySelectionSource(f.tables, row)
        assert.throws(() => selectJourneySoulReward(f.tables, source, 9, chosen.itemid), {
            code: ErrorCode.InvalidArgument,
        })
        const missing = {
            find(name, id) {
                return name === 'soulessence' ? undefined : f.tables.find(name, id)
            },
        }
        assert.throws(() => selectJourneySoulReward(missing, source, chosen.itemid, 9), {
            code: ErrorCode.SoulEssenceConfNotExist,
        })
    } finally {
        f.close()
    }
})
test('complete current soul pool rejects missing unselected config, mixed resources, duplicate members and damaged quantities before selection', () => {
    const f = fixture('complete-source-validation')
    try {
        const def = selectionDefinition(f.tables),
            row = { ...def.row, rewards: [{ itemtype: 3, itemid: def.box.id, itemnum: 1 }] },
            first = def.choices[0],
            unselected = def.choices[1]
        const view = (reward, missing) => ({
            find(name, id) {
                if (name === 'common_item' && id === def.box.id) return { ...def.box, giftBagReward: reward }
                if (name === 'soulessence' && id === missing) return undefined
                return f.tables.find(name, id)
            },
        })
        const token = (r) => `${r.itemtype}#${r.itemid}#${r.itemnum}`,
            full = def.choices.map(token).join('|')
        assert.throws(() => journeySelectionSource(view(full, unselected.itemid), row), {
            code: ErrorCode.SoulEssenceConfNotExist,
        })
        for (const tail of [token({ ...unselected, itemtype: 1 }), token({ ...unselected, itemnum: 2 }), token(first)])
            assert.throws(() => journeySelectionSource(view(`${token(first)}|${tail}`), row), {
                code: ErrorCode.JourneyConfError,
            })
        for (const tail of ['9#not-a-number#1', '9#1#0', '9#1#1#2'])
            assert.throws(() => journeySelectionSource(view(`${token(first)}|${tail}`), row), {
                code: ErrorCode.GameConfig,
            })
        const before = f.saved(),
            find = f.tables.find.bind(f.tables)
        f.tables.find = (name, id) => (name === 'soulessence' && id === unselected.itemid ? undefined : find(name, id))
        try {
            assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s: [first.itemid, 9] }), {
                code: ErrorCode.SoulEssenceConfNotExist,
            })
        } finally {
            f.tables.find = find
        }
        assert.deepEqual(f.saved(), before)
    } finally {
        f.close()
    }
})
test('real reward codec and SQL failures preserve entitlement/profile/allocator, retry restores the missing owned cache and subsequent replay grants nothing', () => {
    const f = fixture('atomic'),
        client = new CurrentSoulConsumer()
    try {
        client.consume(f, f.packets())
        const def = selectionDefinition(f.tables),
            chosen = def.choices[0]
        trustedClaimedPoints(f, def.row.point)
        const request = f.frame('JourneyReceiveSpecialReward', { u32s: [chosen.itemid, chosen.itemtype] }),
            before = f.saved(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byId.get(11883).rsp) throw Error('journey-special-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(request), /journey-special-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), before)
        f.store.db.exec(
            "CREATE TRIGGER journey_choice_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'journey-choice-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(request), /journey-choice-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER journey_choice_abort')
        }
        assert.deepEqual(f.saved(), before)
        f.dispatch(request)
        client.consume(f, f.packets())
        assert.equal(client.shown, 1)
        assert.equal(souls(f).length, before.state.player.soulessence_infos.soulessences.length + 1)
        const count = souls(f).length
        assert.deepEqual(f.dispatch(request).rewards, [])
        assert.equal(souls(f).length, count)
    } finally {
        f.close()
    }
})
test('manual published capacity failure consumes no300-point entitlement, does not discard old assets, and can be retried later', () => {
    const f = fixture('capacity')
    try {
        const def = selectionDefinition(f.tables),
            chosen = def.choices[0]
        trustedClaimedPoints(f, def.row.point)
        const cap = Number(f.tables.get('game').find((r) => r.title === 'BAG_LIMIT_SOULESSENCE').value)
        let need = cap - souls(f).length
        while (need > 0) {
            const n = Math.min(need, 1000)
            f.gm(`give 9 ${chosen.itemid} ${n}`)
            need -= n
        }
        const before = f.saved()
        assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s: [chosen.itemid, chosen.itemtype] }), {
            code: ErrorCode.SoulEssenceBagFull,
        })
        assert.deepEqual(f.saved(), before)
        assert.equal(souls(f).length, cap)
        assert.equal(f.state().journey.pointMask & def.bit, 0)
        assert.equal(f.state().journey.specialItem, undefined)
    } finally {
        f.close()
    }
})
