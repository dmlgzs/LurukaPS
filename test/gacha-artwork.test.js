import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import configImages from '../configs/gacha-artwork.json' with { type: 'json' }
import { GachaArtwork } from '../src/gacha-artwork.js'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    silent = { warn: () => {} }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hasCode = (code) => (error) => error.code === code
test('all actual local artwork has matching identity, PNG dimensions and source hashes', () => {
    const art = new GachaArtwork(),
        urls = art.urls('http://example.test:1234/irrelevant/')
    assert.equal(art.images.size, 7)
    assert.deepEqual(Object.keys(urls).sort(), [
        '1:101010',
        '1:112002',
        '1:199008',
        '9:10121',
        '9:10122',
        '9:10175',
        '9:10200',
    ])
    assert.equal(configImages.source.table_version, '2451868')
    assert.equal(configImages.source.asset_version, '2302423')
    for (const row of configImages.images) {
        const bytes = art.files.get(new URL(urls[row.key]).pathname).bytes
        assert.equal(digest(bytes), row.sha256)
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        assert.equal(bytes.readUInt32BE(16), row.width)
        assert.equal(bytes.readUInt32BE(20), row.height)
        assert(row.bundle.name && /^[0-9a-f]{64}$/.test(row.bundle.sha256))
        assert(Number.isInteger(row.bundle.crc32))
        assert(urls[row.key].startsWith('http://example.test:1234/assets/gacha/'))
    }
})
test('corrupt artwork configuration is rejected before a listener or account operation', () => {
    for (const mutate of [
        (cfg) => {
            cfg.schema_version = 2
        },
        (cfg) => {
            cfg.images.push(cfg.images[0])
        },
        (cfg) => {
            cfg.images[0].key = '1:4294967296'
        },
        (cfg) => {
            cfg.images[0].key = '3:101010'
        },
        (cfg) => {
            cfg.images[0].width++
        },
        (cfg) => {
            cfg.images[0].height++
        },
        (cfg) => {
            cfg.images[0].sha256 = '0'.repeat(64)
        },
        (cfg) => {
            cfg.images[0].png += '\n'
        },
        (cfg) => {
            cfg.images[0].png = Buffer.alloc(32).toString('base64')
        },
    ]) {
        const copy = structuredClone(configImages)
        mutate(copy)
        assert.throws(() => new GachaArtwork(copy), hasCode(ErrorCode.GameConfig))
    }
    const art = new GachaArtwork()
    for (const base of ['not a URL', 'ftp://example.test/', 'http://user:password@example.test/'])
        assert.throws(() => art.urls(base), hasCode(ErrorCode.GameConfig))
})
test('real gacha details expose every UP portrait through immutable GET/HEAD without database or RNG writes', async () => {
    const server = await startServer(
        { ...config, host: '127.0.0.1', gamePort: 0, httpPort: 0, database: ':memory:' },
        silent,
    )
    const base = `http://127.0.0.1:${server.web.address().port}`
    try {
        const changes = () => server.store.db.prepare('SELECT total_changes() AS n').get().n
        const initial = changes(),
            seen = new Set()
        // No account is loaded; random draws and balance changes are not part of metadata.
        server.store.transact = () => {
            throw Error('metadata must not transact')
        }
        for (const poolId of [1001, 2001, 8001, 9001, 10001]) {
            const response = await fetch(base + '/version/client/ClientGachaPoolDetailReq', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ poolId, serverId: 0 }),
            })
            assert.equal(response.status, 200)
            const detail = (await response.json()).data.detail.probability_up_target
            const objects = [...detail.star5.objects, ...detail.star4.objects]
            assert.equal(detail.hidden, objects.length === 0)
            for (const item of objects) {
                assert(item.name && item.cdnImage.startsWith(base + '/assets/gacha/'))
                if (seen.has(item.cdnImage)) continue
                seen.add(item.cdnImage)
                const image = await fetch(item.cdnImage),
                    bytes = Buffer.from(await image.arrayBuffer())
                assert.equal(image.status, 200)
                assert.equal(image.headers.get('content-type'), 'image/png')
                assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
                assert.equal(image.headers.get('content-length'), String(bytes.length))
                const hash = digest(bytes),
                    etag = '"' + hash + '"'
                assert.equal(new URL(item.cdnImage).pathname, '/assets/gacha/' + hash + '.png')
                assert.equal(image.headers.get('etag'), etag)
                assert.match(image.headers.get('cache-control'), /immutable/)
                const head = await fetch(item.cdnImage, { method: 'HEAD' })
                assert.equal(head.status, 200)
                assert.equal(head.headers.get('content-length'), String(bytes.length))
                assert.equal((await head.arrayBuffer()).byteLength, 0)
                const cached = await fetch(item.cdnImage, { headers: { 'if-none-match': etag } })
                assert.equal(cached.status, 304)
                assert.equal((await cached.arrayBuffer()).byteLength, 0)
            }
        }
        assert.equal(seen.size, 7)
        assert.equal(changes(), initial)
        for (const suffix of [
            'does-not-exist.png',
            '../configs/gacha-artwork.json',
            '%2e%2e%2fconfigs%2fgacha-artwork.json',
        ])
            assert.equal((await fetch(base + '/assets/gacha/' + suffix)).status, 404)
        const method = await fetch([...seen][0], { method: 'POST' })
        assert.equal(method.status, 405)
        assert.equal(method.headers.get('allow'), 'GET, HEAD')
        assert.equal(changes(), initial)
    } finally {
        await server.close()
    }
})
test('automatic local portraits preserve explicit deployment URLs and configured public host', async () => {
    const override = 'https://example.test/custom.png'
    const server = await startServer(
        {
            ...config,
            host: '127.0.0.1',
            publicHost: 'game.example.test',
            gamePort: 0,
            httpPort: 0,
            database: ':memory:',
            gachaPolicy: { detail_images: { '1:101010': override } },
        },
        silent,
    )
    try {
        const url = `http://127.0.0.1:${server.web.address().port}/version/client/ClientGachaPoolDetailReq`
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ poolId: 1001 }),
        })
        const up = (await response.json()).data.detail.probability_up_target
        assert.equal(up.hidden, false)
        assert.equal(up.star5.objects[0].cdnImage, override)
        assert(
            up.star4.objects.every((row) =>
                row.cdnImage.startsWith(`http://game.example.test:${server.web.address().port}/assets/gacha/`),
            ),
        )
    } finally {
        await server.close()
    }
})
