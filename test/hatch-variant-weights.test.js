import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup, tables, protocol, start } from './hatching-workers-fixture.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createEggs } from '../src/eggs.js'
import { hatchEffects, applyHatchEffects, validateHatchEffects } from '../src/hatch-effects.js'
import { ErrorCode } from '../src/error-codes.js'
const plan = hatchEffects(tables, { egg_affix: [4] })
function shadow(patch) {
    return {
        get: tables.get.bind(tables),
        find: (name, id) => {
            const r = tables.find(name, id)
            return name === 'pet' && id === 500043 ? { ...r, ...patch } : r
        },
    }
}
function accepted(f) {
    let id
    f.store.transact(f.session.id, 0, (s) => {
        const draw = [7000, 7900]
        id = createEggs(tables, s, 30004001, 1, () => draw.shift())[0].guid
    })
    start(f, id)
    return id
}
const finish = (f, id) => f.call('HatOutPetEgg', { build_guid: 18, egg_guid: id })
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
            game.tick(session.id)
        },
        close: () => store.close(),
    }
}
test('6507 followup uses actual three-model weights and non-100 totals without inventing uniform or rounding', () => {
    for (const [id, draw, expected, total] of [
        [500043, 0, 1, 99],
        [500043, 32, 1, 99],
        [500043, 33, 2, 99],
        [500043, 65, 2, 99],
        [500043, 66, 3, 99],
        [500043, 98, 3, 99],
        [500185, 0, 1, 13],
        [500185, 5, 1, 13],
        [500185, 6, 2, 13],
        [500185, 9, 2, 13],
        [500185, 10, 3, 13],
        [500185, 12, 3, 13],
    ]) {
        const pet = { config_id: id }
        applyHatchEffects(tables, pet, plan, (max) => {
            assert.equal(max, total)
            return draw
        })
        assert.equal(pet.color, expected)
        assert.equal(pet.special, 1)
    }
})
test('6507 followup actual current small-float-butterfly egg with forced-color producer now hatches into one configured model', () => {
    const f = setup()
    try {
        const id = accepted(f)
        assert.deepEqual(f.state().petEggs.find((e) => e.guid === id).egg_affix, [4])
        f.advance(tables.find('pet_egg', 30004001).eggTime)
        const out = finish(f, id),
            r = out.find((p) => p.id === 6507).data,
            pet = f.state().pets.find((p) => p.guid === r.pet_guid)
        assert.equal(pet.config_id, 500043)
        assert([1, 2, 3].includes(pet.color))
        assert.deepEqual(r.triggered_affix_ids, [4])
        assert(out.findIndex((p) => p.id === 6517) < out.findIndex((p) => p.id === 6507))
        const before = f.state().pets
        finish(f, id)
        assert.deepEqual(f.state().pets, before)
    } finally {
        f.close()
    }
})
test('6507 followup validates listed model IDs and matching weights rather than fallback to uniform choice', () => {
    for (const patch of [
        { petSpecialWeight: '' },
        { petSpecialWeight: '1#1|4#1' },
        { petSpecial: '1|2', petSpecialWeight: '1#1|2#1|3#1' },
        { petSpecialWeight: '1#1|1#1|3#1' },
        { petSpecialWeight: '1#-1|2#1|3#1' },
    ]) {
        assert.throws(
            () => applyHatchEffects(shadow(patch), { config_id: 500043 }, plan, () => 0),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
    const p = { config_id: 500043 }
    applyHatchEffects(shadow({ petSpecialWeight: '1#0|2#0|3#5' }), p, plan, () => 0)
    assert.equal(p.color, 3)
    assert.throws(
        () => applyHatchEffects(shadow({ petSpecialWeight: '1#0|2#0|3#0' }), { config_id: 500043 }, plan, () => 0),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
test('6507 followup weighted model is stable after actual codec rollback and real SQLite reconnect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-model-')),
        file = path.join(dir, 's.sqlite')
    let f = setup(file),
        encode = protocol.encode
    try {
        const id = accepted(f)
        f.close()
        f = reconnect(file)
        f.advance(tables.find('pet_egg', 30004001).eggTime)
        const before = f.state()
        let selected
        protocol.encode = function (name, value, ...rest) {
            if (name === protocol.byId.get(6517).rsp) selected = structuredClone(value.pet_infos.pets.at(-1))
            if (name === protocol.byId.get(6507).rsp) throw Error('variant codec')
            return encode.call(this, name, value, ...rest)
        }
        assert.throws(() => finish(f, id), /variant codec/)
        assert.deepEqual(f.state(), before)
        protocol.encode = encode
        finish(f, id)
        assert.deepEqual(
            f.state().pets.find((p) => p.guid === selected.guid),
            selected,
        )
        f.close()
        f = reconnect(file)
        assert.equal(f.state().pets.find((p) => p.guid === selected.guid).color, selected.color)
        assert.equal(finish(f, id).find((p) => p.id === 6507).data.pet_guid, selected.guid)
    } finally {
        protocol.encode = encode
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('6507 followup still rejects egg pools without a real model and leaves probability enhancement/parent behavior explicit', () => {
    assert.throws(
        () => validateHatchEffects(tables, { configid: 40003007, egg_affix: [4] }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
    assert.throws(
        () => hatchEffects(tables, { egg_affix: [3] }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
    assert.throws(
        () => hatchEffects(tables, { egg_affix: [], secondary_parents: { guid: '1' } }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})
