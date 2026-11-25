import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import policy from '../configs/mall-schedule-policy.json' with { type: 'json' }
import { mallLocalTimeIds, mallCommonTimeDefinitions } from '../src/mall-time-policy.js'
import { mallSchedule, mallScheduleOpen } from '../src/mall-schedule.js'
import { MallCatalog } from '../src/mall.js'
import { ActivityCatalog } from '../src/activities.js'
import { configTime } from '../src/time-definitions.js'
import { ErrorCode } from '../src/error-codes.js'

const baseRows = () => ({
    mall_shop: [{ shopId: 301, timelimit: 20001 }],
    mall_goods: [{ goodsId: 1, timelimit: 0 }],
    mall_pay_goods: [{ goodsId: 2, timelimit: 920302 }],
    mall_shop_recommend: [{ id: 3, timelimit: 830002 }],
})
function fixture(t, rows = baseRows(), versions = ['3217420', '3217420', '3217420']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-mall-time-policy-'))
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
    fs.writeFileSync(
        path.join(root, 'tables_index.json'),
        JSON.stringify({
            complete: true,
            packageVersions: Object.fromEntries(
                ['raw_base_package', 'raw_nostreaming_package', 'raw_streaming_package'].map((name, i) => [
                    name,
                    versions[i],
                ]),
            ),
            tables: Object.keys(rows).map((name) => ({ name, section: 'core', file: `Tables/${name}.json` })),
        }),
    )
    return {
        dir,
        get(name) {
            return JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'))
        },
    }
}
const mallError = (error) => error.code === ErrorCode.MallConfigError
const gameConfig = (error) => error.code === ErrorCode.GameConfig

test('approved current policy derives only actual positive mall references, including recommendations', (t) => {
    const rows = baseRows()
    rows.mall_goods.push({ goodsId: 4, timelimit: 20001 })
    const tables = fixture(t, rows)
    assert.deepEqual(mallLocalTimeIds(tables), new Set([20001, 920302, 830002]))
    for (const id of [20001, 920302, 830002]) {
        assert.deepEqual(mallSchedule(tables, id), { start: 0, end: 0 })
        assert.equal(mallScheduleOpen(tables, id, 1790000000), true)
    }
    for (const id of [998002, 999999, 60000]) assert.throws(() => mallSchedule(tables, id), mallError)
})

test('the policy cannot authorize other or mixed resource versions', (t) => {
    for (const versions of [
        ['2451868', '2451868', '2451868'],
        ['3217420', '3217420', '3217421'],
    ]) {
        const tables = fixture(t, baseRows(), versions)
        assert.equal(mallLocalTimeIds(tables), undefined)
        assert.throws(() => mallSchedule(tables, 920302), mallError)
    }
})

test('disabling local policy restores controlled missing-calendar errors and emits no display windows', (t) => {
    const tables = fixture(t)
    const disabled = { ...policy, enabled: false }
    assert.throws(() => mallSchedule(tables, 920302, disabled), mallError)
    assert.deepEqual([...mallCommonTimeDefinitions(tables, disabled)], [])
})

test('approval metadata and official/local distinction are required to enable the strategy', (t) => {
    const tables = fixture(t)
    for (const settings of [
        { ...policy, userApproved: false },
        { ...policy, notOfficial: false },
        { ...policy, localStrategy: 'open-everything' },
    ])
        assert.throws(() => mallSchedule(tables, 920302, settings), gameConfig)
})

test('missing or corrupt declared mall policy sources cannot silently expand the scope', (t) => {
    const tables = fixture(t)
    fs.unlinkSync(path.join(tables.dir, 'mall_shop_recommend.json'))
    assert.throws(() => mallLocalTimeIds(tables), { code: 'ENOENT' })
    fs.writeFileSync(path.join(tables.dir, 'mall_shop_recommend.json'), '{')
    assert.throws(() => mallLocalTimeIds(tables), SyntaxError)
})

test('an enabled mall policy cannot bypass a missing or corrupt declared static calendar', (t) => {
    const tables = fixture(t, { ...baseRows(), common_timelimit: [] })
    fs.unlinkSync(path.join(tables.dir, 'common_timelimit.json'))
    assert.throws(() => mallSchedule(tables, 920302), { code: 'ENOENT' })
    fs.writeFileSync(path.join(tables.dir, 'common_timelimit.json'), '{')
    assert.throws(() => mallSchedule(tables, 920302), SyntaxError)
})

test('damaged mall reference values remain GameConfig errors', (t) => {
    const rows = baseRows()
    rows.mall_pay_goods[0].timelimit = '920302'
    assert.throws(() => mallLocalTimeIds(fixture(t, rows)), gameConfig)
})

test('PlayerMallGoods retains 0/0 without changing purchase conditions or table values', (t) => {
    const rows = baseRows()
    Object.assign(rows.mall_pay_goods[0], {
        refreshType: 0,
        commonCondition: '2004#99',
        goodsNum: 1,
        costPurchaseDiamondNum: 1680,
        item: '3#9001#1',
    })
    const tables = fixture(t, rows)
    const before = tables.get('mall_pay_goods')
    const catalog = new MallCatalog(tables)
    const wire = catalog.goods(true, 2, { player: { basic_info: { lv: 1 } } }, 1790000000)
    assert.equal(wire.begin_time, '0')
    assert.equal(wire.end_time, '0')
    assert.equal(wire.is_all_cond_done, false)
    assert.deepEqual(wire.unlock_cond_id, [2004])
    assert.deepEqual(tables.get('mall_pay_goods'), before)
})

test('5200 display windows are nonzero future intervals while ordinary shop dates remain intact', (t) => {
    const rows = {
        ...baseRows(),
        shop: [{ timelimit: 710, startTime: '20261217-040000', endTime: '20270107-035959' }],
        goods: [],
    }
    const tables = fixture(t, rows)
    const catalog = Object.assign(Object.create(ActivityCatalog.prototype), {
        tables,
        rows: [],
        commonTimeSources: [],
    })
    const times = catalog.commonTimes(1790000000).data_list
    assert.equal(times.length, 4)
    assert.deepEqual(
        times.find((row) => row.time_id === 710),
        {
            time_id: 710,
            start_time: String(configTime('20261217-040000')),
            end_time: String(configTime('20270107-035959')),
        },
    )
    for (const id of [20001, 920302, 830002]) {
        const row = times.find((entry) => entry.time_id === id)
        assert.equal(row.start_time, '0')
        assert.equal(row.end_time, policy.networkDisplayWindow.end)
        assert.ok(BigInt(row.end_time) > 1790000000n)
    }
})

test('local mall display definitions cannot overwrite a conflicting ordinary shop calendar', (t) => {
    const tables = fixture(t, {
        ...baseRows(),
        shop: [{ timelimit: 20001, startTime: '20261217-040000', endTime: '20270107-035959' }],
        goods: [],
    })
    const catalog = Object.assign(Object.create(ActivityCatalog.prototype), {
        tables,
        rows: [],
        commonTimeSources: [],
    })
    assert.throws(() => catalog.commonTimes(1790000000), gameConfig)
})

test('the bounded network display endpoint is configurable and rejects 0/0 or overflowing values', (t) => {
    const tables = fixture(t)
    const settings = { ...policy, networkDisplayWindow: { start: '0', end: '4000000000' } }
    assert.ok([...mallCommonTimeDefinitions(tables, settings)].every((row) => row.end_time === '4000000000'))
    assert.deepEqual(mallSchedule(tables, 920302, settings), { start: 0, end: 0 })
    for (const end of ['0', '18446744073709551615'])
        assert.throws(
            () => [...mallCommonTimeDefinitions(tables, { ...policy, networkDisplayWindow: { start: '0', end } })],
            gameConfig,
        )
})
