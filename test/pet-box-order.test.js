import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup } from './social-wheel-fixture.js'
import { petData, petGrade } from '../src/pets.js'
import { orderPetBoxes } from '../src/pet-box-order.js'
import policy from '../configs/pet-box-order-policy.json' with { type: 'json' }
import { ErrorCode } from '../src/error-codes.js'
function seed(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.pets = [500024, 500045, 500001, 500007].map((id, i) => ({
            ...petData(f.tables, id, String(1000 + i), [106, 103, 204, 201][i]),
            lv: [7, 2, 4, 1][i],
            grade: [30, 10, 20, 20][i],
        }))
        s.lockedPetBoxes = []
    })
}
const positions = (s) => Object.fromEntries(s.pets.map((p) => [p.guid, p.box_id]))
function request(f, rule, extra = {}) {
    return f.call('OrderPetBoxInfo', { box: 1, is_all: false, is_seq_order: true, order_id: rule, ...extra })
}
test('6542 current-box sorting physically updates positions by wire grade then level without moving other boxes;6517 precedes ACK', () => {
    const f = setup()
    try {
        seed(f)
        const before = f.state()
        const out = request(f, [1, 2])
        assert.deepEqual(positions(f.state()), { 1000: 102, 1001: 101, 1002: 204, 1003: 201 })
        assert(out.findIndex((p) => p.id === 6517) < out.findIndex((p) => p.id === 6542))
        for (const p of f.state().pets) {
            const old = before.pets.find((o) => o.guid === p.guid)
            assert.deepEqual({ ...p, box_id: old.box_id }, old)
        }
        assert.deepEqual(f.state().player, before.player)
        assert.deepEqual(f.state().home, before.home)
    } finally {
        f.close()
    }
})
test('6542 all-scope acceptsbox0 and all4ordered priorities from actual currentpet table; reverse and configurable direction are real', () => {
    const f = setup()
    try {
        seed(f)
        for (const rule of [1, 2, 3, 4]) {
            const before = f.state(),
                value = (p) =>
                    rule === 1
                        ? p.grade
                        : rule === 2
                          ? p.lv
                          : rule === 3
                            ? Number(String(f.tables.find('pet', p.config_id).element).split('|')[0])
                            : f.tables.find('pet', p.config_id).petStage
            const expected = [...before.pets].sort((a, b) => value(a) - value(b) || a.box_id - b.box_id)
            request(f, [rule], { box: 0, is_all: true })
            assert.deepEqual(
                [...f.state().pets].sort((a, b) => a.box_id - b.box_id).map((p) => p.guid),
                expected.map((p) => p.guid),
            )
        }
        request(f, [2], { box: 0, is_all: true, is_seq_order: false })
        assert.deepEqual(
            [...f.state().pets].sort((a, b) => a.box_id - b.box_id).map((p) => p.lv),
            [7, 4, 2, 1],
        )
        policy.sequentialDirection = 'descending'
        request(f, [2], { box: 0, is_all: true, is_seq_order: true })
        assert.deepEqual(
            [...f.state().pets].sort((a, b) => a.box_id - b.box_id).map((p) => p.lv),
            [7, 4, 2, 1],
        )
    } finally {
        policy.sequentialDirection = 'ascending'
        f.close()
    }
})
test('6542 ties retain original physical order and repeated sorting does not increment pet revision', () => {
    const f = setup()
    try {
        seed(f)
        request(f, [1], { is_all: true, box: 0 })
        let s = f.state(),
            tied = s.pets.filter((p) => p.grade === 20).sort((a, b) => a.box_id - b.box_id)
        assert.deepEqual(
            tied.map((p) => p.guid),
            ['1003', '1002'],
        )
        request(f, [1], { is_all: true, box: 0 })
        assert.deepEqual(f.state().pets, s.pets)
        assert.equal(f.state().petRevision, s.petRevision)
    } finally {
        f.close()
    }
})
test('6542 locked box is protected in single/globalscope; pet lock alone permits relocation, invalid priority/box does not mutate', () => {
    const f = setup()
    try {
        seed(f)
        f.store.transact(f.session.id, 0, (s) => (s.lockedPetBoxes = [1]))
        let before = f.state()
        assert.throws(
            () => request(f, [1]),
            (e) => e.code === ErrorCode.PetBoxAlreadlyLock,
        )
        assert.deepEqual(f.state(), before)
        request(f, [2], { is_all: true, box: 0 })
        assert.deepEqual(
            f.state().pets.filter((p) => p.box_id < 200),
            before.pets.filter((p) => p.box_id < 200),
        )
        assert(f.state().pets.every((p) => p.is_lock))
        for (const data of [
            { box: 0, order_id: [1] },
            { box: 999, order_id: [1] },
            { box: 2, order_id: [] },
            { box: 2, order_id: [1, 1] },
            { box: 2, order_id: [5] },
        ]) {
            before = f.state()
            assert.throws(
                () => f.call('OrderPetBoxInfo', data),
                (e) => [ErrorCode.PetBoxNotExist, ErrorCode.InvalidArgument].includes(e.code),
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.close()
    }
})
test('6542 carriedbox0 and trialactors are never packed into persistent slots or alter formations', () => {
    const f = setup()
    try {
        seed(f)
        const state = f.state(),
            base = structuredClone(state.pets[0])
        state.pets.push({
            ...base,
            guid: '144115188075855999',
            box_id: 0,
            hero_id: state.player.heros_info.heros[0].guid,
        })
        state.pets.push({ ...base, guid: ((9n << 56n) | 1n).toString(), box_id: 0 })
        const actors = structuredClone(state.pets.slice(-2)),
            groups = structuredClone(state.player.group_mgrs)
        orderPetBoxes({ tables: f.tables, state }, { box: 0, is_all: true, is_seq_order: true, order_id: [2] })
        assert.deepEqual(state.pets.slice(-2), actors)
        assert.deepEqual(state.player.group_mgrs, groups)
        assert.equal(state.pets.filter((p) => p.box_id > 0).length, 4)
    } finally {
        f.close()
    }
})
test('6542 scoring uses existing fallback only for old missinggrade; invalid overlap and codec failures roll back', () => {
    const f = setup(),
        encode = f.protocol.encode
    try {
        seed(f)
        const state = f.state()
        delete state.pets[0].grade
        const expected = petGrade(f.tables, state.pets[0])
        assert(Number.isFinite(expected))
        orderPetBoxes({ tables: f.tables, state }, { box: 1, is_seq_order: true, order_id: [1] })
        assert.equal(state.pets[0].grade, undefined)
        const bad = f.state()
        bad.pets[1].box_id = bad.pets[0].box_id
        assert.throws(
            () => orderPetBoxes({ tables: f.tables, state: bad }, { box: 1, is_seq_order: true, order_id: [1] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        for (const id of [6517, 6542]) {
            const before = f.state(),
                type = f.protocol.byId.get(id).rsp
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('box-sort codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => request(f, [1]), /box-sort codec/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
test('6542 SQLite reopen retains physical layout, pet identities and inventory without grants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-order-')),
        file = path.join(dir, 's.sqlite')
    let f = setup(file)
    try {
        seed(f)
        request(f, [2, 3, 4, 1], { is_all: true, box: 0 })
        const before = f.state()
        f.close()
        f = setup(file)
        assert.deepEqual(positions(f.state()), positions(before))
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(
            f.state().pets.map((p) => p.guid),
            before.pets.map((p) => p.guid),
        )
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
