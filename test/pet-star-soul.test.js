import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'
import { addItems } from '../src/inventory.js'
import { petModules } from '../src/battle.js'
import { petSoulRow, petSoulAttributes, planPetSoulUpgrade } from '../src/pet-star-soul.js'
import { ErrorCode } from '../src/error-codes.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
const guid = '144115188099999999',
    packed = (group, node) => ((BigInt(group) << 32n) | BigInt(node)).toString()
function setup(configId = 500001) {
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
        return call('EnterGame', { open_id: 'star-soul' })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.player.basic_info.lv = 30
        s.player.basic_info.gold = 100000000
        s.pets.push(petData(tables, configId, guid, 2001))
        addItems(
            s,
            [1720001, 1720002, 1720003, 1720004, tables.find('pet', configId).starsoulItem]
                .filter((id) => Number.isInteger(id) && id > 0)
                .map((itemid) => ({ itemid, itemnum: 10000 })),
        )
    })
    return {
        store,
        call,
        login,
        edit,
        state: () => store.load(session.id).state,
        up: () => call('KiboStarLinkSoulUpdate', { u64: guid }),
    }
}
const target = (s) => s.pets.find((p) => p.guid === guid)
test('11912 advances actual current-node costs, packs next position, publishes pet and combat cache before ACK and survives database/login', () => {
    const f = setup()
    try {
        const before = f.state(),
            cost = tables.get('pet_starsoul').find((r) => r.templateId === 1000 && r.group === 1 && r.node === 1)
        const packets = f.up(),
            after = f.state()
        assert.equal(target(after).soul_link_level, packed(1, 2))
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold - 5000)
        assert.equal(cost.item, '10#2#5000')
        const petSync = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoPetInfoSync').id),
            ack = packets.findIndex((p) => p.id === 11912)
        assert.ok(petSync >= 0 && petSync < ack)
        const attrs = petSoulAttributes(tables, target(after))
        assert.equal(attrs.get(1), 25)
        assert.equal(attrs.get(5), 800)
        const base = petModules(tables, before, target(before), []),
            boosted = petModules(tables, after, target(after), [])
        const attr = (m, id) => BigInt(m.modules[0].sub_modules[0].attrs.attrs.find((a) => a.attr_id === id).attr_val)
        assert.equal(attr(boosted, 1) - attr(base, 1), 250000n)
        assert.equal(attr(boosted, 5) - attr(base, 5), 8000000n)
        f.store.flushPending()
        f.login()
        assert.equal(target(f.state()).soul_link_level, packed(1, 2))
    } finally {
        f.store.close()
    }
})
test('all four real nonterminal templates advance through every node, use species materials and train only selected nonfixed skills to table maximum', () => {
    for (const template of [1000, 1100, 2000, 2100]) {
        const config = tables.get('pet').find((p) => p.starsoulId === template && tables.find('template_value', p.id)),
            f = setup(config.id)
        try {
            const original = structuredClone(target(f.state()).inherent_skills),
                rows = tables
                    .get('pet_starsoul')
                    .filter((r) => r.templateId === template)
                    .sort((a, b) => a.group - b.group || a.node - b.node)
            for (let i = 0; i < rows.length - 1; i++) {
                const before = f.state(),
                    row = rows[i],
                    expected = rows[i + 1],
                    p = target(before),
                    mat = tables.find('pet', p.config_id).starsoulItem
                const stock = (state) =>
                    state.player.sbag_infos.items.filter((x) => x.itemid === mat).reduce((n, x) => n + x.itemnum, 0)
                f.up()
                assert.equal(target(f.state()).soul_link_level, packed(expected.group, expected.node))
                assert.equal(stock(before) - stock(f.state()), row.kiboItemNum)
            }
            const p = target(f.state())
            assert.equal(petSoulRow(tables, p).row.type, 3)
            const fixed = new Set(
                String(config.fixedSkillList)
                    .split('|')
                    .filter(Boolean)
                    .map((s) => Number(s.split('#')[0])),
            )
            for (const skill of p.inherent_skills) {
                const chosen =
                    skill.skill_slot === 206 ||
                    skill.skill_slot === 601 ||
                    (skill.skill_slot >= 1 && skill.skill_slot <= 50 && !fixed.has(skill.skill_slot))
                assert.equal(
                    skill.skill_lv,
                    chosen ? 5 : original.find((x) => x.skill_slot === skill.skill_slot).skill_lv,
                )
            }
            const before = f.state()
            assert.throws(
                () => f.up(),
                (e) => e.code === ErrorCode.PetSoulMaxLevel,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.close()
        }
    }
})
test('not-owned, player-level, suppression, trial and active NPC roster guards leave resources and progression unchanged', () => {
    const f = setup()
    try {
        assert.throws(
            () => f.call('KiboStarLinkSoulUpdate', { u64: '999' }),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        f.edit((s) => {
            s.player.basic_info.lv = 1
        })
        let before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.PetSoulLevelCondition,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.player.basic_info.lv = 30
            target(s).suppress_lv = 6
            const force = s.player.attr_infos.attrs.find((a) => a.attr_id === 22)
            if (force) force.attr_val = '0'
            else s.player.attr_infos.attrs.push({ attr_id: 22, attr_val: '0' })
        })
        before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.PetSoulLevelCondition,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            target(s).suppress_lv = 0
            target(s).trial = true
        })
        before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            delete target(s).trial
            s.multiCampaign = { duel_id: 2, start_time: 100 }
            s.combat = {
                npcDuel: {
                    duel_id: 2,
                    start_time: 100,
                    map_id: s.world.map_id,
                    actors: { actor: { camp: 1, source_guid: guid } },
                },
            }
        })
        before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('insufficient materials, corrupted saved position and failed pet-sync encoding roll back progression and costs', () => {
    const f = setup()
    try {
        f.edit((s) => {
            target(s).soul_link_level = packed(2, 3)
            s.player.sbag_infos.items.forEach((i) => {
                if (i.itemid === 2200020) i.itemnum = 0
            })
        })
        let before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            target(s).soul_link_level = packed(4, 99)
        })
        before = f.state()
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            delete target(s).soul_link_level
        })
        before = f.state()
        const old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoPetInfoSync').rsp) throw Error('star-soul codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.up(), /codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('terminal template 3000 and missing template cannot be treated as free upgrades', () => {
    const config = tables.get('pet').find((p) => p.starsoulId === 3000 && tables.find('template_value', p.id)),
        f = setup(config.id)
    try {
        assert.throws(
            () => f.up(),
            (e) => e.code === ErrorCode.PetSoulMaxLevel,
        )
    } finally {
        f.store.close()
    }
    const f2 = setup()
    try {
        const p = target(f2.state())
        const missingTemplate = {
            get: tables.get.bind(tables),
            find: (name, id) => (name === 'pet' ? { ...tables.find(name, id), starsoulId: 0 } : tables.find(name, id)),
        }
        assert.throws(
            () => planPetSoulUpgrade(missingTemplate, f2.state(), p),
            (e) => e.code === ErrorCode.PetSoulLinkConfig,
        )
    } finally {
        f2.store.close()
    }
})
