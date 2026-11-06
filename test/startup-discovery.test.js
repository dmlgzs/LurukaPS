import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'

test('offline startup responses complete version queries without creating accounts or inventing downloads', async (t) => {
    const config = {
        ...configuration(),
        host: '127.0.0.1',
        publicHost: '127.0.0.1',
        gamePort: 0,
        httpPort: 0,
        database: ':memory:',
        diagnostics: false,
    }
    const server = await startServer(config, { warn: () => {} })
    const origin = `http://127.0.0.1:${server.web.address().port}`
    const request = async (name, body) => {
        const response = await fetch(origin + '/version/client/' + name, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        })
        return { status: response.status, value: await response.json() }
    }
    try {
        const before = server.store.db.prepare('SELECT total_changes() AS n').get().n
        await t.test('account classification explicitly follows the native old-account failure fallback', async () => {
            for (const account of ['', 'unknown-local-player', 'another-player']) {
                const { status, value } = await request('getAccountV1', { account, timestamp: 1 })
                assert.equal(status, 200)
                assert.equal(value.code, 0)
                assert.deepEqual(value.data, { isOld: true })
                assert.equal(value.api, 'GetAccountV1')
                assert(Number.isSafeInteger(value.timestamp) && value.timestamp > 1)
                assert(!('pid' in value.data), 'Do not invent the meaning of the unused pid field')
            }
        })
        await t.test('no pre-download returns a non-null successful envelope with both tracks absent', async () => {
            const { status, value } = await request('preDownloadConfV1', { hotVersion: 'untrusted-request-version' })
            assert.equal(status, 200)
            assert.equal(value.code, 0)
            assert.deepEqual(value.data, { jobName: config.jobName, gray: null, formal: null })
            assert(!('resHotUpdateVersion' in value.data))
        })
        await t.test('resource CDN and registered patch versions remain real configured values', async () => {
            const cdn = await request('getCdnV1')
            assert.equal(cdn.status, 200)
            assert.equal(cdn.value.code, 0)
            assert.equal(cdn.value.data.cdn, config.cdnUrl)
            assert.deepEqual(cdn.value.data.cdnBak, config.cdnBackupUrls)
            assert.notEqual(cdn.value.data.cdn, origin + '/')
            const patch = await request('patchV1', { hotVersion: '1.1.1.1.1' })
            assert.equal(patch.value.data.hotSlots.releaseHot, config.hotRevision)
            assert.equal(patch.value.data.serverSlots.releaseServer.serverInfo[0].port, server.tcp.address().port)
        })
        await t.test('unavailable cloud storage and unknown routes never claim empty success', async () => {
            const token = await request('cdntoken')
            assert.equal(token.status, 503)
            assert.equal(token.value.code, token.status)
            assert(!('data' in token.value))
            const unknown = await request('getAccountV10')
            assert.equal(unknown.status, 404)
            const asset = await fetch(origin + '/chs/windows/30_package_1938420.hash')
            assert.equal(asset.status, 404, 'No fabricated hash or implicit resource proxy')
        })
        assert.equal(server.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0)
        assert.equal(server.store.db.prepare('SELECT count(*) AS n FROM players').get().n, 0)
        assert.equal(server.store.db.prepare('SELECT total_changes() AS n').get().n, before)
        assert.equal(server.store.pending.size, 0)
    } finally {
        await server.close()
    }
})
