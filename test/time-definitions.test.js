import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { staticTimeRows, shopTimeDefinitions, mergeCommonTime, configTime } from '../src/time-definitions.js'
import { ActivityCatalog } from '../src/activities.js'
import { GachaDrawEngine } from '../src/gacha-draw.js'
import { ShopCatalog } from '../src/shops.js'
import { mallSchedule } from '../src/mall-schedule.js'
import { ErrorCode } from '../src/error-codes.js'
import gachaPolicy from '../configs/gacha-local-policy.json' with { type: 'json' }

function fixture(t, rows, { manifest = true, declared = Object.keys(rows) } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-time-definitions-'))
    const dir = path.join(root, 'Tables')
    fs.mkdirSync(dir)
    t.after(() => {
        for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file))
        fs.rmdirSync(dir)
        const index = path.join(root, 'tables_index.json')
        if (fs.existsSync(index)) fs.unlinkSync(index)
        fs.rmdirSync(root)
    })
    for (const [name, value] of Object.entries(rows))
        fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value))
    if (manifest)
        fs.writeFileSync(
            path.join(root, 'tables_index.json'),
            JSON.stringify({
                complete: true,
                tables: declared.map((name) => ({ name, section: 'core', file: `Tables/${name}.json` })),
            }),
        )
    return {
        dir,
        reads: [],
        get(name) {
            this.reads.push(name)
            return JSON.parse(fs.readFileSync(path.join(this.dir, name + '.json'), 'utf8'))
        },
    }
}

const startTime = '20261217-040000',
    endTime = '20270107-035959',
    dated = (timelimit) => ({ timelimit, startTime, endTime })
const gameConfig = (error) => error.code === ErrorCode.GameConfig
function activity(tables, rows = []) {
    return Object.assign(Object.create(ActivityCatalog.prototype), {
        tables,
        rows,
        tours: { presentationWindow: (window) => window },
        commonTimeSources: [],
    })
}
function gacha(tables, rows, policy = gachaPolicy) {
    return Object.assign(Object.create(GachaDrawEngine.prototype), {
        tables,
        policy,
        catalog: { pools: new Map(rows.map((row) => [row.gachaId, row])) },
    })
}

test('a complete export proves static-calendar absence without reading or manufacturing a table', (t) => {
    const tables = fixture(t, { shop: [], goods: [] })
    assert.equal(staticTimeRows(tables), undefined)
    assert.deepEqual(tables.reads, [])
})

test('without an export manifest a missing calendar remains an error', (t) => {
    const tables = fixture(t, { shop: [] }, { manifest: false })
    assert.throws(() => staticTimeRows(tables), { code: 'ENOENT' })
})

test('a declared calendar whose file is missing remains an error', (t) => {
    const tables = fixture(t, { shop: [] }, { declared: ['shop', 'common_timelimit'] })
    assert.throws(() => staticTimeRows(tables), { code: 'ENOENT' })
})

test('a declared corrupt calendar cannot activate an offline gacha policy', (t) => {
    const tables = fixture(t, { common_timelimit: [] })
    fs.writeFileSync(path.join(tables.dir, 'common_timelimit.json'), '{')
    assert.throws(() => gacha(tables, []).window({ gachaId: 1, timelimit: 91 }), SyntaxError)
})

test('a declared calendar must be an array', (t) => {
    const tables = fixture(t, { common_timelimit: {} })
    assert.throws(() => staticTimeRows(tables), gameConfig)
})

test('a damaged declared calendar row cannot be interpreted as an absent reference', (t) => {
    const tables = fixture(t, { common_timelimit: [{ id: '91', startTime, endTime }] })
    assert.throws(() => gacha(tables, []).window({ gachaId: 1, timelimit: 91 }), gameConfig)
})

test('direct dates derive arbitrary shared shop IDs and coalesce identical definitions', (t) => {
    const tables = fixture(t, {
        shop: [dated(765432)],
        goods: [dated(765432), dated(765433), { timelimit: 765434 }],
    })
    assert.deepEqual(
        [...shopTimeDefinitions(tables)],
        [
            { time_id: 765432, start_time: String(configTime(startTime)), end_time: String(configTime(endTime)) },
            { time_id: 765433, start_time: String(configTime(startTime)), end_time: String(configTime(endTime)) },
        ],
    )
})

test('conflicting direct dates for one shop time ID fail with GameConfig', (t) => {
    const tables = fixture(t, {
        shop: [dated(765432)],
        goods: [{ ...dated(765432), endTime: '20270108-035959' }],
    })
    assert.throws(() => [...shopTimeDefinitions(tables)], gameConfig)
})

test('damaged direct shop dates fail rather than becoming open-ended definitions', (t) => {
    const tables = fixture(t, { shop: [{ ...dated(765432), startTime: '20260231-040000' }], goods: [] })
    assert.throws(() => [...shopTimeDefinitions(tables)], gameConfig)
})

test('5200 combines shop dates, explicit activity policy and explicit gacha policy in one collection', (t) => {
    const tables = fixture(t, { shop: [dated(710)], goods: [] })
    const catalog = activity(tables, [{ id: 1, timelimit: 810 }])
    const engine = gacha(tables, [{ gachaId: 2, timelimit: 910 }])
    catalog.commonTimeSources.push(() => engine.commonTimes())
    const times = catalog.commonTimes(1790000000).data_list
    assert.deepEqual(new Set(times.map((row) => row.time_id)), new Set([710, 810, 910]))
    assert.equal(times.find((row) => row.time_id === 710).start_time, String(configTime(startTime)))
    assert.equal(times.find((row) => row.time_id === 810).end_time, String(configTime('20301231-235959')))
    assert.equal(times.find((row) => row.time_id === 910).end_time, String(gachaPolicy.offline_window.end))
    assert.equal(tables.reads.includes('common_timelimit'), false)
})

test('a conflicting external time source cannot overwrite the complete 5200 collection', (t) => {
    const tables = fixture(t, { shop: [dated(710)], goods: [] })
    const catalog = activity(tables)
    catalog.commonTimeSources.push(() => ({ data_list: [{ time_id: 710, start_time: '0', end_time: '0' }] }))
    assert.throws(() => catalog.commonTimes(1790000000), gameConfig)
})

test('static calendar values and existing activity expiry policy remain in the aggregate', (t) => {
    const tables = fixture(t, {
        common_timelimit: [
            { id: 810, startTime: '20200101-000000', endTime: '20200102-000000' },
            { id: 811, startTime, endTime },
        ],
    })
    const catalog = activity(tables, [{ id: 1, timelimit: 810 }])
    const times = catalog.commonTimes(1790000000).data_list
    assert.equal(times.find((row) => row.time_id === 810).end_time, String(configTime('20301231-235959')))
    assert.equal(times.find((row) => row.time_id === 811).end_time, String(configTime(endTime)))
})

test('the existing closed gacha policy still closes a missing calendar reference', (t) => {
    const tables = fixture(t, { shop: [], goods: [] })
    const engine = gacha(tables, [], { ...gachaPolicy, missing_schedule: 'closed' })
    assert.deepEqual(engine.window({ gachaId: 1, timelimit: 91 }), { start: 0, end: 0, closed: true })
})

test('ordinary shops use current explicit dates and reject references without a source', (t) => {
    const tables = fixture(t, { shop: [], goods: [] })
    const catalog = Object.assign(Object.create(ShopCatalog.prototype), { tables })
    assert.deepEqual(catalog.schedule(dated(710)), { start: configTime(startTime), end: configTime(endTime) })
    assert.throws(() => catalog.schedule({ timelimit: 711 }), gameConfig)
})

test('new mall calendar IDs remain controlled MallConfigError without an approved policy', (t) => {
    const tables = fixture(t, { mall_shop: [] })
    for (const id of [20001, 920302])
        assert.throws(
            () => mallSchedule(tables, id),
            (error) => error.code === ErrorCode.MallConfigError,
        )
})

test('time merging normalizes wire integers and rejects invalid or conflicting values', () => {
    const times = new Map()
    mergeCommonTime(times, { time_id: 1, start_time: 1, end_time: 2 })
    mergeCommonTime(times, { time_id: 1, start_time: '1', end_time: '2' })
    assert.equal(times.size, 1)
    assert.throws(() => mergeCommonTime(times, { time_id: 1, start_time: 1, end_time: 3 }), gameConfig)
    assert.throws(() => mergeCommonTime(times, { time_id: 2, start_time: '-1', end_time: '2' }), gameConfig)
    assert.throws(
        () => mergeCommonTime(times, { time_id: 2, start_time: '0', end_time: '18446744073709551616' }),
        gameConfig,
    )
})
