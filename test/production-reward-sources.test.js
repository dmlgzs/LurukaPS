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
import { cookingRecipe } from '../src/cooking.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
function fixture(tableSet = tables) {
    let now = 1800000000,
        seq = 0
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tableSet, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: ++seq, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'production-reward-source' })
    store.transact(session.id, 0, (state) => {
        state.player.basic_info.lv = 6
        state.player.sbag_infos.items = [{ itemid: 300000, itemnum: 30 }]
    })
    call('HomeTechnologyLevelUp', { type: 1, subType: 11005 })
    return {
        protocol,
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        advance: (seconds) => {
            now += seconds
        },
        edit: (callback) => store.transact(session.id, 0, callback),
        finish: () => call('ProductFinish', { guid: 1, is_all: true }).find((p) => p.id === 6111).data,
        start: () => call('ProductStart', { build_guid: 1, product_id: 302001, count: 3 }),
        close: () => store.close(),
    }
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)

test('6111 uses table production source for partial and final workbench harvests without changing quantities', () => {
    const f = fixture()
    try {
        f.start()
        f.advance(3)
        const partial = f.finish()
        assert.equal(partial.reward.src, 37)
        assert.equal(partial.reward.rewards.find((i) => i.itemid === 350000).itemnum, 1)
        assert.equal(stock(f.state(), 350000), 1)
        assert.throws(() => f.finish(), /No finished/)
        f.advance(6)
        const final = f.finish()
        assert.equal(final.reward.src, 37)
        assert.equal(final.reward.rewards.find((i) => i.itemid === 350000).itemnum, 2)
        assert.equal(stock(f.state(), 350000), 3)
        assert.equal(f.state().home.craftCounts[302001], 3)
    } finally {
        f.close()
    }
})

test('queued cooking uses the same 6111 harvest source rather than a task or instantaneous cooking source', () => {
    const f = fixture()
    try {
        const recipe = cookingRecipe(tables, 9004201),
            materials = recipe.requirements.map(({ count, choices }) => ({ item_id: choices[0], item_num: count }))
        f.edit((state) => {
            state.world.map_id = 701
            state.player.basic_info.lv = 45
            state.tasks = []
            state.taskRecords = tables
                .get('task')
                .filter((row) => row.type === 1)
                .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
            state.home.builds.push({
                guid: 18,
                build_id: 100011,
                build_type: 10,
                status: 1,
                locate: { block_id: 101, anchor: 6750237, direction: 0 },
                product: [],
            })
            for (const id of [22010, 22015, 22020])
                state.home.technology.levels[id] = { level: 1, lastTime: 0, isOpened: true }
            state.player.sbag_infos.items = materials.map((item, n) => ({
                itemid: item.item_id,
                itemnum: item.item_num * 2,
                itemtype: 3,
                guid: String(100 + n),
            }))
        })
        f.call('CookRequest', { build_guid: 18, cook_id: 9004201, cook_count: 2, cook_material: materials })
        f.advance(recipe.product.time * 2)
        const out = f.call('ProductFinish', { guid: 18, is_all: true }).find((p) => p.id === 6111).data
        assert.equal(out.reward.src, 37)
        assert.equal(out.reward.rewards.find((i) => i.itemid === 9004201).itemnum, 2)
        assert.equal(stock(f.state(), 9004201), 2)
    } finally {
        f.close()
    }
})

test('missing production presentation source logs and still grants the earned workbench output', () => {
    const modified = Object.create(tables)
    modified.find = (name, id) => (name === 'reason_itemnum_change' && id === 37 ? undefined : tables.find(name, id))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-production-source-')),
        file = path.join(dir, 'warnings.jsonl'),
        old = process.env.LURUKAPS_REWARD_SOURCE_LOG,
        previous = console.warn,
        messages = []
    process.env.LURUKAPS_REWARD_SOURCE_LOG = file
    console.warn = (line) => messages.push(line)
    const f = fixture(modified)
    try {
        f.start()
        f.advance(9)
        assert.equal(f.finish().reward.src, undefined)
        assert.equal(stock(f.state(), 350000), 3)
        assert(messages.some((line) => line.includes('source_row_missing')))
        const record = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1))
        assert.equal(record.operation, 'productionFinish')
        assert.equal(record.source_id, 37)
        assert.equal(record.fallback, 'omit_src')
    } finally {
        f.close()
        console.warn = previous
        if (old === undefined) delete process.env.LURUKAPS_REWARD_SOURCE_LOG
        else process.env.LURUKAPS_REWARD_SOURCE_LOG = old
        // Keep the small temporary diagnostic artifact; never touch live data.
    }
})

test('6111 encoding failure rolls back output, craft progress and queue before a single successful retry', () => {
    const f = fixture()
    try {
        f.start()
        f.advance(9)
        const before = f.store.load(f.session.id),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, data) => {
            if (name.endsWith('SCProductFinish')) throw Error('injected harvest packet failure')
            return encode(name, data)
        }
        assert.throws(() => f.finish(), /injected harvest packet failure/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.protocol.encode = encode
        assert.equal(f.finish().reward.src, 37)
        assert.equal(stock(f.state(), 350000), 3)
        assert.throws(
            () => f.finish(),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.equal(stock(f.state(), 350000), 3)
    } finally {
        f.close()
    }
})
