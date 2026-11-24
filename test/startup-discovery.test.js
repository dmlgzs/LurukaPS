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
        await t.test('OBT patch preserves the observed wire shape and advertises only the local gate', async () => {
            const { status, value } = await request('v1_0/patch', {
                zoneId: '22',
                buildPipe: '1',
                jobName: config.jobName,
                version: 'untrusted-package-version',
                hotVersion: '1.1.1.1.1',
            })
            assert.equal(status, 200)
            assert.equal(value.api, 'PatchV1')
            assert.equal(value.code, 0)
            assert.equal(value.data.version, '1.0.0.30')
            assert.equal(value.data.hotSlots.releaseHot, '2868078.3217420.3217420.3217420.3217420')
            assert.equal(value.data.pkgUrl, '', 'Preserve the observed empty package-download URL')
            assert.deepEqual(
                Object.keys(value.data).sort(),
                [
                    'status',
                    'pkgUrl',
                    'zoneId',
                    'buildPipe',
                    'jobName',
                    'version',
                    'waterMark',
                    'serverSlots',
                    'hotSlots',
                    'returnAll',
                    'isWhite',
                    'isForceHot',
                ].sort(),
            )
            assert(!('latestVersion' in value.data), 'Do not invent a field absent from the official response')
            const slot = value.data.serverSlots.releaseServer
            assert(!('hotHistory' in slot), 'Do not fabricate history missing from the actual release slot')
            const gate = slot.serverInfo[0]
            assert.equal(gate.addr, config.publicHost)
            assert.equal(gate.port, server.tcp.address().port)
            assert.equal(gate.id, config.serverId)
            assert.equal(gate.tls, false)
            assert.equal(gate.state, 0)
            assert(
                gate.name.includes(config.clientChannel),
                'OBT version filter matches server name against client channel',
            )
            assert.equal(gate.hotTag, 1)
            assert.equal(gate.clientLog, '')
            assert.equal(gate.clientLogBurst, '')
            assert.deepEqual(JSON.parse(gate.bakGate), [{ addr: config.publicHost, port: gate.port }])
            assert.deepEqual(
                Object.keys(gate).sort(),
                [
                    'name',
                    'type',
                    'addr',
                    'port',
                    'bakGate',
                    'state',
                    'version',
                    'tag',
                    'tls',
                    'desc',
                    'timestamp',
                    'pay',
                    'id',
                    'zoneId',
                    'clientLog',
                    'clientLogBurst',
                    'hotTag',
                ].sort(),
            )
        })
        await t.test(
            'OBT CDN, account classification and empty pre-download use their real endpoint names',
            async () => {
                const cdn = await request('v1_0/getcdn')
                assert.equal(cdn.value.api, 'GetCdnV1')
                assert.deepEqual(cdn.value.data, { cdn: config.cdnUrl, cdnBak: config.cdnBackupUrls })
                const account = await request('v1_0/getaccount', { account: 'offline-local', zoneId: 22, serverTag: 0 })
                assert.equal(account.value.api, 'GetAccountV1')
                assert.deepEqual(account.value.data, {
                    zoneId: 22,
                    serverTag: 0,
                    account: 'offline-local',
                    isOld: true,
                })
                const preload = await request('v1_0/predownloadconf')
                assert.equal(preload.value.api, 'PreDownloadConfV1')
                assert.equal(preload.value.code, 0)
                assert.deepEqual(preload.value.data, { jobName: config.jobName, gray: null, formal: null })
                assert.equal((await request('v1_0/patches')).status, 404)
                assert.equal((await request('v1_0/getcdn/asset')).status, 404)
                assert.equal((await request('v1_0/GetCdn')).status, 404)
                assert.equal((await request('v1_1/patch')).status, 404)
            },
        )
        assert.equal(server.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0)
        assert.equal(server.store.db.prepare('SELECT count(*) AS n FROM players').get().n, 0)
        assert.equal(server.store.db.prepare('SELECT total_changes() AS n').get().n, before)
        assert.equal(server.store.pending.size, 0)
    } finally {
        await server.close()
    }
})
