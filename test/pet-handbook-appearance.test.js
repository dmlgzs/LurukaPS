import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(file = ':memory:', count = 1) {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'handbook-appearance' })
    store.transact(session.id, 0, (state) => {
        state.pets = []
        state.petBoxes = []
        state.recordPets = []
        state.tasks = []
        state.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        for (const hero of state.player.heros_info.heros) hero.pet_id = '0'
        for (const manager of state.player.group_mgrs)
            for (const group of manager.groups) for (const h of group.heros) h.pet_id = '0'
        for (const pet of createPets(tables, state, 500002, count)) {
            pet.comprehension = tables.get('pet_learningenum').map(({ attributeEnum: attr_id }) => ({
                attr_id,
                level: 1,
                init_level: 1,
                cur_exp: 0,
                value: tables.get('pet_talent_upgrade').find((r) => r.attrId === attr_id && r.level === 1).InterA,
            }))
        }
    })
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'handbook-appearance' })
    }
    reload()
    const state = () => store.load(session.id).state
    return {
        store,
        game,
        call,
        state,
        reload,
        get session() {
            return session
        },
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
const entry = (f, id = 500002) => f.state().petHandbook[id]
const select = (f, colorful_id, pet_id = 500002) => f.call('PetHandbookColorfulSelect', { pet_id, colorful_id })
function observe(f, index, fields) {
    f.edit((state) => {
        Object.assign(state.pets[index], fields)
        state.petRevision++
    })
    f.reload()
}

test('a normal acquired species can select zero without inventing palette ownership or modifying its instances', () => {
    const f = fixture()
    try {
        const before = f.state(),
            out = select(f, 0)
        assert.deepEqual(out.find((p) => p.id === 11022).data, { pet_id: 500002, colorful_id: 0 })
        assert.deepEqual(entry(f).colorfuls, [])
        assert.deepEqual(entry(f).colors, [])
        assert.deepEqual(f.state().pets, before.pets)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert(!out.some((p) => p.id === 11020))
    } finally {
        f.close()
    }
})

test('all15 starcolorId values are learned from permanent profile evidence and saved before11022 acknowledgement', () => {
    const palettes = tables.get('pet_color'),
        f = fixture(':memory:', palettes.length)
    try {
        assert.equal(palettes.length, 15)
        f.edit((state) => {
            for (const [i, row] of palettes.entries())
                Object.assign(state.pets[i], { colorful: row.starcolorId, special: 4 })
            state.petRevision++
        })
        f.reload()
        const expected = palettes.map((r) => r.starcolorId).sort((a, b) => a - b)
        assert.deepEqual(entry(f).colorfuls, expected)
        const before = f.state()
        for (const row of palettes) {
            assert.notEqual(row.id, row.starcolorId)
            const out = select(f, row.starcolorId)
            assert.deepEqual(out.find((p) => p.id === 11022).data, { pet_id: 500002, colorful_id: row.starcolorId })
            assert.equal(entry(f).selected_colorful, row.starcolorId)
            const sync = assertSyncBefore(protocol, out, 'CSProtoPetHandbookInfoSync', 11022)
            const book = sync.at(-1).data.infos.find((r) => r.pet_id === 500002)
            assert.equal(book.selected_colorful, row.starcolorId)
            assert.deepEqual(book.colorfuls, expected)
        }
        assert.deepEqual(f.state().pets, before.pets)
        assert.deepEqual(f.state().player.basic_info, before.player.basic_info)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.equal(entry(f).lv, before.petHandbook[500002].lv)
        assert.equal(entry(f).rewarded_lv, before.petHandbook[500002].rewarded_lv)
    } finally {
        f.close()
    }
})

test('regular variant indexes and star palette identifiers have separate acquired histories', () => {
    const f = fixture(':memory:', 2)
    try {
        observe(f, 0, { color: 1, special: 1 }) // unit200021 has the real specialParm s1.
        observe(f, 1, { colorful: 1001, special: 4 })
        assert.deepEqual(entry(f).colors, [1])
        assert.deepEqual(entry(f).colorfuls, [1001])
        const before = f.store.load(f.session.id)
        assert.throws(
            () => select(f, 1),
            (e) => e.code === ErrorCode.HandbookConfNone,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        select(f, 1001)
        select(f, 0)
        assert.equal(entry(f).selected_colorful, 0)
        assert.deepEqual(entry(f).colors, [1])
        assert.deepEqual(entry(f).colorfuls, [1001])
        assert.equal(f.state().pets[0].color, 1)
        assert.equal(f.state().pets[1].colorful, 1001)
    } finally {
        f.close()
    }
})

test('unknown palettes, unacquired palettes, other species and malformed saved histories cannot authorize selection', () => {
    const f = fixture()
    try {
        observe(f, 0, { colorful: 1001, special: 4 })
        for (const [id, pet, code] of [
            [1002, 500002, ErrorCode.PetHandbookHaveNone],
            [99999, 500002, ErrorCode.HandbookConfNone],
            [1001, 500001, ErrorCode.PetHandbookNotFound],
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => select(f, id, pet),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            state.petHandbook[500002].colorfuls = '1001'
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => select(f, 1001),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('repeated selection is idempotent and release preserves acquired palettes independently of the bag', () => {
    const f = fixture()
    try {
        observe(f, 0, { colorful: 1001, special: 4, is_lock: false })
        select(f, 1001)
        const before = f.state(),
            again = select(f, 1001)
        assert(!again.some((p) => p.id === 11020))
        assert.deepEqual(entry(f), before.petHandbook[500002])
        f.call('DelPet', { pet_list: [f.state().pets[0].guid] })
        assert.equal(f.state().pets.length, 0)
        assert.deepEqual(entry(f).colorfuls, [1001])
        select(f, 0)
        select(f, 1001)
        assert.equal(entry(f).selected_colorful, 1001)
    } finally {
        f.close()
    }
})

test('temporary profile appearance and another species cannot fill this species palette entitlement', () => {
    const f = fixture(':memory:', 2)
    try {
        observe(f, 0, { colorful: 1001, type: 2 })
        assert.deepEqual(entry(f).colorfuls, [])
        assert.throws(
            () => select(f, 1001),
            (e) => e.code === ErrorCode.PetHandbookHaveNone,
        )
        f.edit((state) => {
            const [other] = createPets(tables, state, 500023, 1)
            other.colorful = 1001
        })
        f.reload()
        assert.deepEqual(entry(f, 500023).colorfuls, [1001])
        assert.deepEqual(entry(f).colorfuls, [])
        assert.throws(
            () => select(f, 1001),
            (e) => e.code === ErrorCode.PetHandbookHaveNone,
        )
    } finally {
        f.close()
    }
})

test('response or handbook synchronization failures roll back the saved preference', () => {
    const f = fixture(),
        encode = protocol.encode,
        packet = f.game.packet
    try {
        observe(f, 0, { colorful: 1001, special: 4 })
        const before = f.store.load(f.session.id),
            reply = protocol.byName.get('CSProtoPetHandbookColorfulSelect').rsp
        protocol.encode = function (type, data, ...args) {
            if (type === reply) throw Error('palette reply failed')
            return encode.call(this, type, data, ...args)
        }
        assert.throws(() => select(f, 1001), /palette reply failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        protocol.encode = encode
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoPetHandbookInfoSync') throw Error('palette sync failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => select(f, 1001), /palette sync failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        select(f, 1001)
        assert.equal(entry(f).selected_colorful, 1001)
    } finally {
        protocol.encode = encode
        f.game.packet = packet
        f.close()
    }
})

test('real SQLite restart retains the observed appearances and selected palette without editing pet colors', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-book-palette-'))
    const file = path.join(directory, 'state.sqlite'),
        f = fixture(file)
    let restored,
        closed = false
    try {
        observe(f, 0, { colorful: 1015, color: 1, special: 5 })
        select(f, 1015)
        const before = f.state()
        f.close()
        closed = true
        restored = new Store(file)
        const game = new Game(protocol, restored, tables),
            session = {},
            login = protocol.byName.get('CSProtoEnterGame')
        const out = game.dispatch(session, {
            id: login.id,
            seq: 1,
            payload: protocol.encode(login.req, { open_id: 'handbook-appearance' }),
        })
        const after = restored.load(session.id).state
        assert.equal(after.petHandbook[500002].selected_colorful, 1015)
        assert.deepEqual(after.petHandbook[500002].colorfuls, [1015])
        assert.deepEqual(after.petHandbook[500002].colors, [1])
        assert.equal(after.pets[0].colorful, before.pets[0].colorful)
        const info = protocol
            .decode('SCPetHandbookInfoSync', out.find((p) => p.id === 11020).payload)
            .infos.find((p) => p.pet_id === 500002)
        assert.equal(info.selected_colorful, 1015)
    } finally {
        if (!closed) f.close()
        restored?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-book-palette-'))
        fs.rmSync(directory, { recursive: true })
    }
})
