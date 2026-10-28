import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantHomeExperience } from '../src/home-experience.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    baseTables = new Tables(config.tables)
function fixture({ find, level = 1, file = ':memory:', seed = true } = {}) {
    const tables = Object.create(baseTables)
    if (find) tables.find = (name, id) => find(name, id, baseTables.find(name, id))
    const store = new Store(file),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ ...p, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'canteen-transactions' })
    const edit = (fn) => store.transact(session.id, 0, fn)
    if (seed)
        edit((s) => {
            s.world.map_id = 701
            if (level > 1) {
                const amount = baseTables
                    .get('home_level')
                    .filter((r) => r.id < level)
                    .reduce((n, r) => n + r.exp, 0)
                grantHomeExperience(tables, s, amount)
            }
            s.home.builds.push({
                guid: 19,
                build_id: 10011,
                build_type: 6,
                status: 1,
                locate: { block_id: 101, anchor: 7536681, direction: 0 },
                pet_canteen: { pets: [], food_value: 0, foods: [], food_extra_ids: [7], food_extra_values: [9] },
            })
            s.home.inventory.push({ build_id: 10011, total_num: 1, used_num: 1, unlock: true })
            s.player.sbag_infos.items = s.player.sbag_infos.items.filter((r) => ![9002901, 306000].includes(r.itemid))
            s.player.sbag_infos.items.push(
                { guid: '900000001', itemtype: 3, itemid: 9002901, itemnum: 5000 },
                { guid: '900000002', itemtype: 3, itemid: 306000, itemnum: 5000 },
            )
            s.nextItemGuid = '900000003'
            s.inventoryVersion = 1
        })
    return { tables, store, session, call, edit, state: () => store.load(session.id).state, close: () => store.close() }
}
const request = (items, operate_type = 1, build_guid = 19) => ({ build_guid, operate_type, items })
const dish = (itemnum = 1, itemid = 9002901) => ({ itemid, itemnum, itemtype: 3 })
const canteen = (s) => s.home.builds.find((b) => b.guid === 19).pet_canteen
const bag = (s, id) => s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
function rejects(f, data, code) {
    const before = f.store.load(f.session.id)
    assert.throws(
        () => f.call('AddPetFood', data),
        (e) => e.code === code,
    )
    assert.deepEqual(f.store.load(f.session.id), before)
}

test('6540 whole-dish deposit/withdraw aggregates request rows, refunds only stocked goods and synchronizes HomeSync before acknowledgement', () => {
    const f = fixture()
    try {
        const acquisition = structuredClone(f.state().itemAcquisitionCounts),
            rev = f.state().homeRevision
        const packets = f.call('AddPetFood', request([dish(2), dish(3)])),
            id = protocol.byName.get('CSProtoHomeSync').id
        assert.deepEqual(canteen(f.state()).foods, [dish(5)])
        assert.equal(canteen(f.state()).food_value, 125)
        assert.equal(bag(f.state(), 9002901), 4995)
        assert.equal(f.state().homeRevision, rev + 1)
        assert(packets.findIndex((p) => p.id === id) < packets.findIndex((p) => p.id === 6540))
        assert.equal(
            packets.find((p) => p.id === id).data.home_builds.find((b) => b.guid === 19).pet_canteen.food_value,
            125,
        )
        rejects(f, request([dish(6)], 0), ErrorCode.PetFoodSubFail)
        f.call('AddPetFood', request([dish(5)], 0))
        assert.equal(bag(f.state(), 9002901), 5000)
        assert.deepEqual(canteen(f.state()).foods, [])
        assert.equal(canteen(f.state()).food_value, 0)
        assert.deepEqual(canteen(f.state()).food_extra_ids, [7])
        assert.deepEqual(canteen(f.state()).food_extra_values, [9])
        assert.deepEqual(f.state().itemAcquisitionCounts, acquisition)
    } finally {
        f.close()
    }
})

test('6540 uses actual cultivation home_level table_food_max plus building trough, accepts the exact boundary and rejects one extra point', () => {
    for (const level of [1, 2, 10, 100]) {
        const f = fixture({ level })
        try {
            const capacity =
                baseTables.find('home_building', 10011).trough + baseTables.find('home_level', level).table_food_max
            assert.equal(f.state().home.level, level)
            f.call('AddPetFood', request([dish(capacity, 306000)]))
            assert.equal(canteen(f.state()).food_value, capacity)
            rejects(f, request([dish(1, 306000)]), ErrorCode.HomeFoodOver)
            f.call('AddPetFood', request([dish(capacity, 306000)], 0))
            assert.equal(canteen(f.state()).food_value, 0)
        } finally {
            f.close()
        }
    }
})

test('6540 distinguishes missing food configuration, nonfood, zero-use and malformed satiety without changing caller foodType policy', () => {
    for (const [kind, code] of [
        ['missing', ErrorCode.FoodConfNotExist],
        ['zero', ErrorCode.FoodIsNotPetUse],
        ['negative', ErrorCode.GameConfig],
        ['fraction', ErrorCode.GameConfig],
        ['string', ErrorCode.GameConfig],
        ['large', ErrorCode.GameConfig],
    ]) {
        const f = fixture({
            find: (name, id, row) =>
                name === 'food' && id === 9002901
                    ? kind === 'missing'
                        ? undefined
                        : {
                              ...row,
                              satietyScore: { zero: 0, negative: -1, fraction: 1.5, string: '25', large: 0x100000000 }[
                                  kind
                              ],
                          }
                    : row,
        })
        try {
            rejects(f, request([dish()]), code)
        } finally {
            f.close()
        }
    }
    const f = fixture()
    try {
        const nonfood = baseTables.get('common_item').find((r) => r.type !== 355)
        rejects(f, request([dish(1, nonfood.id)]), ErrorCode.ItemIsNotFood)
        f.call('AddPetFood', request([dish(1, 306000)]))
        assert.equal(canteen(f.state()).food_value, 1)
    } finally {
        f.close()
    }
})

test('6540 rejects duplicate, malformed or inconsistent saved whole-dish ledgers atomically instead of overwriting or regenerating value', () => {
    for (const kind of [
        'duplicate',
        'negative',
        'fraction',
        'type',
        'mismatch',
        'zero-value',
        'value-overflow',
        'missing-list',
    ]) {
        const f = fixture()
        try {
            f.edit((s) => {
                const c = canteen(s)
                c.foods = [dish(2)]
                c.food_value = 50
                if (kind === 'duplicate') {
                    c.foods = [dish(1), dish(2)]
                    c.food_value = 75
                }
                if (kind === 'negative') c.foods[0].itemnum = -1
                if (kind === 'fraction') {
                    c.foods[0].itemnum = 0.04
                    c.food_value = 1
                }
                if (kind === 'type') c.foods[0].itemtype = 10
                if (kind === 'mismatch') c.food_value = 49
                if (kind === 'zero-value') c.food_value = 0
                if (kind === 'value-overflow') c.food_value = 0x100000000
                if (kind === 'missing-list') delete c.foods
            })
            rejects(f, request([dish()]), ErrorCode.GameConfig)
        } finally {
            f.close()
        }
    }
})

test('6540 enforces existing home scene, account building ownership, placement, type and configuration as separate failures', () => {
    const cases = [
        ['scene', ErrorCode.PlayerNotInHome],
        ['unknown', ErrorCode.HomeBuildGuidInvild],
        ['unplaced', ErrorCode.HomeBuildInvalidStatus],
        ['status', ErrorCode.HomeBuildInvalidStatus],
        ['type', ErrorCode.BuildTypeNotMatch],
        ['duplicate', ErrorCode.GameConfig],
        ['config', ErrorCode.BuildConfNotFound],
    ]
    for (const [kind, code] of cases) {
        const f = fixture()
        try {
            f.edit((s) => {
                const b = s.home.builds.find((x) => x.guid === 19)
                if (kind === 'scene') s.world.map_id = 100
                if (kind === 'unplaced') delete b.locate
                if (kind === 'status') b.status = 2
                if (kind === 'type') b.build_type = 2
                if (kind === 'duplicate') s.home.builds.push(structuredClone(b))
                if (kind === 'config') b.build_id = 0x7fffffff
            })
            rejects(f, request([dish()], 1, kind === 'unknown' ? 20 : 19), code)
        } finally {
            f.close()
        }
    }
})

test('6540 rejects aggregate overflow and malformed request types before inventory writes, preserving item shortage semantics', () => {
    const f = fixture()
    try {
        rejects(f, request([dish(0xffffffff), dish(1)]), ErrorCode.InvalidArgument)
        rejects(f, request([{ ...dish(), itemtype: 10 }]), ErrorCode.InvalidArgument)
        rejects(f, request([dish()], 2), ErrorCode.InvalidArgument)
        rejects(f, request([dish(0xffffffff)]), ErrorCode.HomeFoodOver)
        f.edit((s) => {
            s.player.sbag_infos.items.find((r) => r.itemid === 9002901).itemnum = 0
        })
        rejects(f, request([dish()]), ErrorCode.ItemNotEnough)
    } finally {
        f.close()
    }
})

test('6540 withdrawal preflights refund destination overflow and codec failures roll back inventory, foods and HomeSync together', () => {
    const f = fixture(),
        encode = protocol.encode.bind(protocol)
    try {
        f.call('AddPetFood', request([dish(2)]))
        f.edit((s) => {
            s.player.sbag_infos.items.find((r) => r.itemid === 9002901).itemnum = 0xffffffff
        })
        rejects(f, request([dish()], 0), ErrorCode.GameConfig)
        f.edit((s) => {
            s.player.sbag_infos.items.find((r) => r.itemid === 9002901).itemnum = 4998
        })
        for (const name of ['CSProtoHomeSync', 'CSProtoAddPetFood']) {
            const before = f.store.load(f.session.id),
                type = protocol.byName.get(name).rsp
            protocol.encode = (current, data) => {
                if (current === type) throw Error('canteen codec failure')
                return encode(current, data)
            }
            assert.throws(() => f.call('AddPetFood', request([dish()], 0)), /canteen codec failure/)
            assert.deepEqual(f.store.load(f.session.id), before)
            protocol.encode = encode
        }
        f.call('AddPetFood', request([dish()], 0))
        assert.equal(bag(f.state(), 9002901), 4999)
        assert.equal(canteen(f.state()).food_value, 25)
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('6540 whole-dish transfers survive real SQLite restart without duplicate refund or losing unrelated canteen fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen-transactions-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture({ file })
    try {
        f.call('AddPetFood', request([dish(4)]))
        f.close()
        f = fixture({ file, seed: false })
        assert.equal(canteen(f.state()).food_value, 100)
        assert.equal(bag(f.state(), 9002901), 4996)
        f.call('AddPetFood', request([dish(4)], 0))
        f.close()
        f = fixture({ file, seed: false })
        assert.equal(canteen(f.state()).food_value, 0)
        assert.equal(bag(f.state(), 9002901), 5000)
        rejects(f, request([dish()], 0), ErrorCode.PetFoodSubFail)
        assert.deepEqual(canteen(f.state()).food_extra_values, [9])
    } finally {
        f.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
