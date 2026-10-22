import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup, tables, protocol, start, jobs } from './hatching-workers-fixture.js'
import { createEggs } from '../src/eggs.js'
import { hatchEffects, validateHatchEffects, applyHatchEffects, hatchRandom } from '../src/hatch-effects.js'
import { ErrorCode } from '../src/error-codes.js'
function reconnect(file) {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'hatch-workers' })
    return {
        store,
        session,
        game,
        call,
        state: () => store.load(session.id).state,
        advance: (n) => {
            now += n
            return game.tick(session.id)
        },
        close: () => store.close(),
    }
}
function egg(f, affix, config = 20004001) {
    let id
    f.store.transact(f.session.id, 0, (s) => {
        const row = tables.find('pet_egg', config),
            prefix = String(row.affixweight)
                .split('|')
                .map((t) => t.split('#').map(Number))
        let at = 0
        for (const [n, w] of prefix) {
            if (n === affix) break
            at += w
        }
        const draws = [7000, at]
        id = createEggs(tables, s, config, 1, () => draws.shift())[0].guid
    })
    return id
}
const finish = (f, id) => f.call('HatOutPetEgg', { build_guid: 18, egg_guid: id })
const newest = (f) => f.state().pets.at(-1)
test('6507 real egg factory forced flash/variant/star affixes become actual owned pet fields and triggered lists', () => {
    for (const [affix, special] of [
        [6, 2],
        [4, 1],
        [8, 4],
    ]) {
        const f = setup()
        try {
            const id = egg(f, affix),
                before = f.state().pets.length
            assert.deepEqual(f.state().petEggs.find((e) => e.guid === id).egg_affix, [affix])
            start(f, id)
            f.advance(18000)
            const out = finish(f, id),
                r = out.find((p) => p.id === 6507).data,
                pet = newest(f)
            const routed = f.state().hatchReceipts['18:' + id].appearance.routed_special
            const flash = affix === 6 || [2, 3, 5].includes(routed)
            const star = affix === 8 || (affix !== 4 && [4, 5].includes(routed))
            const variant = affix === 4 || (!star && [1, 3].includes(routed))
            assert.equal(pet.special, star ? (flash ? 5 : 4) : variant ? (flash ? 3 : 1) : flash ? 2 : 0)
            assert.deepEqual(r.triggered_affix_ids, [affix])
            assert.equal(r.pet_guid, pet.guid)
            assert.equal(f.state().pets.length, before + 1)
            assert(!f.state().petEggs.some((e) => e.guid === id))
            assert(out.findIndex((p) => p.id === 6517) < out.findIndex((p) => p.id === 6507))
            if (affix === 4) assert.equal(pet.color, 1)
            if (affix === 8) assert(tables.get('pet_color').some((c) => c.starcolorId === pet.colorful))
            assert.equal(f.state().hatchReceipts['18:' + id].petGuid, pet.guid)
        } finally {
            f.close()
        }
    }
})
test('6507 configured palette boundaries and real enum combinations do not invent a distribution', () => {
    for (const [rng, expected] of [
        [() => 0, 1001],
        [(n) => n - 1, 1015],
    ]) {
        const p = { config_id: 500023 },
            plan = hatchEffects(tables, { egg_affix: [6, 8] })
        applyHatchEffects(tables, p, plan, rng)
        assert.equal(p.special, 5)
        assert.equal(p.colorful, expected)
    }
    const p = { config_id: 500023 }
    applyHatchEffects(tables, p, hatchEffects(tables, { egg_affix: [4, 6] }), () => 0)
    assert.equal(p.special, 3)
    assert.equal(p.color, 1)
    assert.throws(
        () => applyHatchEffects(tables, { config_id: 500023 }, hatchEffects(tables, { egg_affix: [8] }), (n) => n),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
test('6507 missing/ambiguous variant does not filter or reroll species; unknown aptitude/probability/rare and parent rules remain explicit', () => {
    assert.throws(
        () => validateHatchEffects(tables, { configid: 40003007, egg_affix: [4] }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
    for (const affix of [1, 2, 3, 5, 7, 9, 10, 11, 12])
        assert.throws(
            () => hatchEffects(tables, { egg_affix: [affix] }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
    assert.throws(
        () => hatchEffects(tables, { egg_affix: [4, 8] }),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => hatchEffects(tables, { egg_affix: [], main_parents: { guid: '1' } }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})
test('6507 modern6111 and legacy6507 receipts prevent cross-entry duplicates and palette/aptitude rerolls', () => {
    const f = setup()
    try {
        const id = egg(f, 8)
        start(f, id)
        const job = jobs(f)[0]
        f.advance(18000)
        const out = f.call('ProductFinish', { guid: 18, product_guids: [job.guid] }),
            r = out.find((p) => p.id === 6111).data.reward.rewards[0],
            before = f.state()
        assert.equal(r.guid, newest(f).guid)
        const repeated = finish(f, id).find((p) => p.id === 6507).data
        assert.equal(repeated.pet_guid, r.guid)
        assert.deepEqual(repeated.triggered_affix_ids, [8])
        assert.deepEqual(f.state().pets, before.pets)
        assert.deepEqual(
            f.call('ProductFinish', { guid: 18, product_guids: [job.guid] }).find((p) => p.id === 6111).data.reward
                .rewards,
            [],
        )
        assert.deepEqual(f.state().pets, before.pets)
    } finally {
        f.close()
    }
})
test('6507 all response failures retain seed/egg/queue and retry yields byte-identical pet random fields', () => {
    for (const target of [6507, 6517, 6518]) {
        const f = setup(),
            encode = protocol.encode
        try {
            const id = egg(f, 8)
            start(f, id)
            f.advance(18000)
            const before = f.state()
            let captured
            const fail = protocol.byId.get(target).rsp
            protocol.encode = function (name, value, ...rest) {
                if (name === protocol.byId.get(6517).rsp) captured = structuredClone(value.pet_infos.pets.at(-1))
                if (name === fail) throw Error('hatch-effect codec')
                return encode.call(this, name, value, ...rest)
            }
            assert.throws(() => finish(f, id), /hatch-effect codec/)
            assert.deepEqual(f.state(), before)
            protocol.encode = encode
            finish(f, id)
            if (captured) assert.deepEqual(newest(f), captured)
            assert.equal(f.state().hatchReceipts['18:' + id].petGuid, newest(f).guid)
        } finally {
            protocol.encode = encode
            f.close()
        }
    }
})
test('6507 cancellation retains the generation seed; legacy seedless queue migration is stable across a failed claim', () => {
    const f = setup(),
        encode = protocol.encode
    try {
        const id = egg(f, 6)
        start(f, id)
        let seed = f.state().eggGenerationSeeds[id]
        f.call('CancelHatchPetEgg', { build_guid: 18, egg_guid: id })
        start(f, id)
        assert.equal(f.state().eggGenerationSeeds[id], seed)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.eggGenerationSeeds
            delete s.eggGenerationVersions
        })
        f.advance(18000)
        let captured
        protocol.encode = function (name, value, ...rest) {
            if (name === protocol.byId.get(6517).rsp) {
                captured = structuredClone(value.pet_infos.pets.at(-1))
                throw Error('legacy hatch codec')
            }
            return encode.call(this, name, value, ...rest)
        }
        assert.throws(() => finish(f, id), /legacy hatch codec/)
        protocol.encode = encode
        finish(f, id)
        assert.deepEqual(newest(f), captured)
    } finally {
        protocol.encode = encode
        f.close()
    }
})
test('6507 SQLite close/reopen retains chosen seed and exposes the same owned pet and affix receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-affix-')),
        file = path.join(dir, 's.sqlite')
    let f = setup(file)
    try {
        const id = egg(f, 6)
        start(f, id)
        const account = f.session.id,
            seed = f.state().eggGenerationSeeds[id]
        f.close()
        f = reconnect(file)
        assert.equal(f.session.id, account)
        assert.equal(f.state().eggGenerationSeeds[id], seed)
        f.advance(18000)
        finish(f, id)
        const pet = structuredClone(newest(f)),
            receipt = structuredClone(f.state().hatchReceipts['18:' + id])
        f.close()
        f = reconnect(file)
        assert.deepEqual(
            f.state().pets.find((p) => p.guid === pet.guid),
            pet,
        )
        assert.deepEqual(f.state().hatchReceipts['18:' + id], receipt)
        assert.equal(finish(f, id).find((p) => p.id === 6507).data.pet_guid, pet.guid)
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('6507 deterministic stream accepts only bounded integers and different accepted seeds produce different draws', () => {
    const a = hatchRandom('0'.repeat(32)),
        b = hatchRandom('1'.repeat(32))
    const aa = Array.from({ length: 12 }, () => a(0x100000000)),
        bb = Array.from({ length: 12 }, () => b(0x100000000))
    assert.notDeepEqual(aa, bb)
    assert(aa.every((n) => Number.isInteger(n) && n >= 0 && n < 0x100000000))
    assert.throws(
        () => a(0),
        (e) => e.code === ErrorCode.GameConfig,
    )
})

test('6507 optional factory RNG keeps ordinary GM pet grant on the default generator and normal inventory sync', () => {
    const f = setup()
    try {
        const count = f.state().pets.length,
            text = (s) => Buffer.from(s).toString('base64')
        const out = f.call('GMCommand', { command: text('give'), args: ['5', '500023', '1'].map(text) })
        assert.equal(f.state().pets.length, count + 1)
        const pet = newest(f)
        assert.equal(pet.config_id, 500023)
        assert.equal(pet.comprehension.length, 6)
        assert(
            pet.comprehension.every(
                (v) => Number.isInteger(v.value) && v.level >= 1 && v.level <= 9 && v.init_level === v.level,
            ),
        )
        assert(out.some((p) => p.id === 6517))
        assert.equal(pet.special ?? 0, 0)
        assert.equal(pet.color ?? 0, 0)
    } finally {
        f.close()
    }
})

test('6507 malformed private seed is rejected atomically instead of overwriting prior state', () => {
    const f = setup()
    try {
        const id = egg(f, 6)
        f.store.transact(f.session.id, 0, (s) => (s.eggGenerationSeeds = []))
        const before = f.state()
        assert.throws(
            () => start(f, id),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('6507 deleting a cancelled egg clears its retained generation seed through the actual release request', () => {
    const f = setup()
    try {
        const id = egg(f, 6)
        start(f, id)
        f.call('CancelHatchPetEgg', { build_guid: 18, egg_guid: id })
        assert(f.state().eggGenerationSeeds[id])
        f.call('DelEgg', { egg_list: [id] })
        assert.equal(f.state().eggGenerationSeeds[id], undefined)
        assert(!f.state().petEggs.some((e) => e.guid === id))
    } finally {
        f.close()
    }
})
