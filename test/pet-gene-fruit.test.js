import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData, petGrade } from '../src/pets.js'
import { addItems } from '../src/inventory.js'
import { planGeneFruit } from '../src/pet-gene-fruit.js'
import { numericGeneAttributes } from '../src/pet-gene-numeric.js'
import { petModules } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base),
    guid = '144115188099999998'
const fruits = tables.get('pet_feed_item').filter((f) => f.type === 3),
    target = (s) => s.pets.find((p) => p.guid === guid)
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
        return call('EnterGame', { open_id: 'gene-fruit' })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        const p = petData(tables, 500001, guid, 2001)
        p.gene_infos = p.gene_infos.slice(0, 1)
        p.gene_state = 1
        s.pets.push(p)
        addItems(
            s,
            fruits.map((f) => ({ itemid: f.id, itemnum: 10 })),
        )
    })
    return {
        store,
        call,
        login,
        edit,
        state: () => store.load(session.id).state,
        use: (item = 1750001, slot = 0) => call('UseGeneFruitReq', { pet_id: guid, item_id: item, slot_pos: slot }),
    }
}
const stock = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
const available = (s) => fruits.find((f) => !target(s).gene_infos.some((g) => g.gene_id === f.dnaParam))
test('6523 one gene fruit appends at next position, consumes one, preserves lock state and sends numeric module5 attributes before ACK', () => {
    const f = setup()
    try {
        const before = f.state(),
            fruit = available(before),
            packets = f.use(fruit.id),
            after = f.state(),
            p = target(after)
        assert.deepEqual(p.gene_infos[1], { pos: 2, gene_id: fruit.dnaParam, gene_lv: 1 })
        assert.equal(p.gene_state, target(before).gene_state)
        assert.equal(stock(before, fruit.id) - stock(after, fruit.id), 1)
        assert.equal(p.grade, petGrade(tables, p))
        assert.equal(p.favor_val, 5)
        const sync = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoPetInfoSync').id),
            ack = packets.findIndex((p) => p.id === 6523)
        assert.ok(sync >= 0 && sync < ack)
        const attrs = numericGeneAttributes(tables, p),
            module = petModules(tables, after, p, []).modules.find((m) => m.module_type === 5)
        assert.ok(attrs.size)
        assert.ok(module.sub_modules[0].attrs.attrs.length)
        // The new fruit remains numeric-only; an existing innate effect now
        // has its independent, validated startup descriptor in the same module.
        assert.deepEqual(
            module.sub_modules[0].skills.skills.map((skill) => skill.skill_id),
            p.gene_infos
                .filter((gene) => tables.find('skill', gene.gene_id)?.skillType === 1)
                .map((gene) => gene.gene_id),
        )
        const effect = tables
            .find('skillsub_attrup', fruit.dnaParam)
            .attributeList.split('|')
            .map((t) => t.split('#').map(Number))
        for (const [id, amount] of effect)
            assert.equal((attrs.get(id) ?? 0) - (numericGeneAttributes(tables, target(before)).get(id) ?? 0), amount)
        f.store.flushPending()
        f.login()
        assert.deepEqual(target(f.state()).gene_infos, p.gene_infos)
    } finally {
        f.store.close()
    }
})
test('6523 all 102 current fruit definitions resolve exact numeric gene and level1 effects without random selection', () => {
    const f = setup()
    try {
        const s = f.state(),
            p = target(s)
        p.gene_infos = []
        assert.equal(fruits.length, 102)
        for (const fruit of fruits) {
            const plan = planGeneFruit(tables, s, p, { item_id: fruit.id, slot_pos: 0 })
            assert.deepEqual(plan.genes, [{ pos: 1, gene_id: fruit.dnaParam, gene_lv: 1 }])
            assert.ok(numericGeneAttributes(tables, { ...p, gene_infos: plan.genes }).size)
        }
    } finally {
        f.store.close()
    }
})
test('6523 full list requires explicit selected replacement and protects innate/same DNA/marked shining and mutation state atomically', () => {
    const f = setup()
    try {
        f.edit((s) => {
            target(s).gene_infos = petData(tables, 500001, guid, 2001).gene_infos
        })
        const fruit = available(f.state())
        let before = f.state()
        assert.throws(
            () => f.use(fruit.id, 0),
            (e) => e.code === ErrorCode.PetGeneAddFail,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(tables.find('pet_dna', target(before).gene_infos[0].gene_id).talentDnaType, 1)
        assert.throws(
            () => f.use(fruit.id, 1),
            (e) => e.code === ErrorCode.PetCharacterDNACannotMutate,
        )
        assert.deepEqual(f.state(), before)
        const old = target(before).gene_infos
        f.use(fruit.id, 8)
        assert.deepEqual(target(f.state()).gene_infos.slice(0, 7), old.slice(0, 7))
        assert.equal(target(f.state()).gene_infos[7].gene_id, fruit.dnaParam)
        before = f.state()
        assert.throws(
            () => f.use(fruit.id, 8),
            (e) => e.code === ErrorCode.OldPetNotExist,
        )
        assert.deepEqual(f.state(), before)
        const next = available(f.state())
        f.edit((s) => {
            target(s).ur_pos = 8
        })
        before = f.state()
        assert.throws(
            () => f.use(next.id, 8),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            target(s).ur_pos = 0
            target(s).mutation_info = { pos: 2, gene_id: fruit.dnaParam }
        })
        before = f.state()
        assert.throws(
            () => f.use(next.id, 8),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('6523 rejects unowned/trial/active-NPC pet, wrong item/slot, expired stock and suppressed pet without consuming or granting anything', () => {
    const f = setup()
    try {
        let before = f.state()
        assert.throws(
            () => f.call('UseGeneFruitReq', { pet_id: '99', item_id: 1750001 }),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        assert.throws(
            () => f.use(1700001),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.use(1750001, 3),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.player.sbag_infos.items.filter((i) => i.itemid === 1750001).forEach((i) => (i.deadtime = 1))
        })
        before = f.state()
        assert.throws(
            () => f.use(),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            target(s).trial = true
        })
        before = f.state()
        assert.throws(
            () => f.use(),
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
                    actors: { source: { camp: 1, source_guid: guid } },
                },
            }
        })
        before = f.state()
        assert.throws(
            () => f.use(),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            delete s.multiCampaign
            delete s.combat
            target(s).suppress_lv = 6
            const attr = s.player.attr_infos.attrs.find((a) => a.attr_id === 22)
            if (attr) attr.attr_val = '0'
        })
        before = f.state()
        assert.throws(
            () => f.use(available(before).id),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('6523 failed PetInfoSync codec restores fruit stock, genes, grade, favor and revisions', () => {
    const f = setup()
    try {
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoPetInfoSync').rsp) throw Error('gene codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.use(available(before).id), /codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
