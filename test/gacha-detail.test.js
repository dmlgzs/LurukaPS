import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { GachaCatalog } from '../src/gacha.js'
import { GachaDrawEngine } from '../src/gacha-draw.js'
import { gachaTables } from '../src/gacha-tables.js'
import { gachaPoolDetail } from '../src/gacha-detail.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
import { GachaArtwork } from '../src/gacha-artwork.js'

const config = configuration(),
    tables = gachaTables(new Tables(config.tables)),
    catalog = new GachaCatalog(tables)
function detail(id, policy) {
    return gachaPoolDetail(catalog, new GachaDrawEngine(catalog, tables, policy), tables, id)
}
test('HTTP model describes all five actual pools using ordinary thresholds and complete candidate names', () => {
    for (const id of catalog.pools.keys()) {
        const result = detail(id)
        assert.equal(result.detail_description.hidden, false)
        assert(result.detail_description.paragraphs.every((p) => p.title && p.content.length))
        let mass = 0
        for (const star of [5, 4, 3]) {
            const group = result.probability_detail['star' + star]
            mass += Number(group.text.replace('基础概率 ', '').replace('%', ''))
            assert(group.objects.length > 0)
            assert(
                group.objects.every((item) => item.name && !/^\d+$/.test(item.name) && typeof item.is_up === 'boolean'),
            )
        }
        assert(Math.abs(mass - 100) < 0.000001)
        assert.equal(result.probability_up_target.hidden, true)
    }
    const limited = detail(1001)
    assert.equal(limited.probability_detail.star5.text, '基础概率 0.8%')
    assert.equal(limited.probability_detail.star4.text, '基础概率 5.2%')
    assert.equal(limited.probability_detail.star3.text, '基础概率 94%')
    assert.deepEqual(limited.probability_detail.star5.objects, [{ name: '涂山小玉', is_up: true }])
    assert.equal(limited.probability_up_target.star5.ratio, '100%')
    assert.equal(limited.probability_up_target.star4.ratio, '50%')
    assert.match(JSON.stringify(detail(8001).detail_description), /十连消耗8枚/)
    assert.match(JSON.stringify(detail(8001).detail_description), /最多观测30次/)
    assert.match(JSON.stringify(detail(9001).detail_description), /首次单次观测免费/)
    assert.match(JSON.stringify(detail(9001).detail_description), /累计50次/)
})

test('UP artwork requires real configured URLs and malformed policy or pool IDs fail before any account operation', () => {
    const images = {
        '1:101010': 'http://127.0.0.1/assets/101010.png',
        '1:199008': 'http://127.0.0.1/assets/199008.png',
        '1:112002': 'http://127.0.0.1/assets/112002.png',
    }
    const result = detail(1001, { detail_images: images })
    assert.equal(result.probability_up_target.hidden, false)
    assert.equal(result.probability_up_target.star5.objects[0].cdnImage, images['1:101010'])
    assert.equal(result.probability_up_target.star4.objects.length, 2)
    assert.throws(
        () => detail(1001, { detail_images: { '1:101010': 'UI/fake.png' } }),
        (e) => e.code === ErrorCode.GameConfig,
    )
    for (const id of [0, -1, null, '1001', 1001.5, 9999])
        assert.throws(
            () => detail(id),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
    // Static details remain readable while the pool is closed; they grant nothing.
    assert.deepEqual(detail(1001, { missing_schedule: 'closed' }), detail(1001))
})

test('the real client URL responds with CardPoolMsg data/detail and performs no SQLite writes', async () => {
    const server = await startServer(
        { ...config, host: '127.0.0.1', gamePort: 0, httpPort: 0, database: ':memory:' },
        { warn: () => {} },
    )
    const url = `http://127.0.0.1:${server.web.address().port}/version/client/ClientGachaPoolDetailReq`
    const changes = () => server.store.db.prepare('SELECT total_changes() AS n').get().n
    const before = changes()
    const send = (body) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', client_sign: 'local-static-metadata' },
            body: JSON.stringify(body),
        })
    try {
        for (const poolId of catalog.pools.keys()) {
            const response = await send({ poolId, serverId: 0 })
            assert.equal(response.status, 200)
            const body = await response.json()
            assert.equal(body.code, 0)
            assert.equal(body.api, 'ClientGachaPoolDetailReq')
            assert.deepEqual(body.data.detail, detail(poolId, { detail_images: new GachaArtwork().urls(url) }))
            assert(Number.isSafeInteger(body.timestamp))
        }
        for (const body of [
            { poolId: 9999 },
            { poolId: -1 },
            { poolId: '1001' },
            { poolId: 1001, serverId: -1 },
            [],
            {},
        ]) {
            const response = await send(body)
            assert.equal(response.status, 400)
            assert.equal((await response.json()).code, ErrorCode.InvalidArgument)
        }
        assert.equal((await fetch(url)).status, 405)
        assert.equal(changes(), before)
    } finally {
        await server.close()
    }
})
