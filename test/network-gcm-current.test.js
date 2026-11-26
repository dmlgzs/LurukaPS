import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
import { connectObtGcmClient } from './helpers/obt-gcm-client.js'

const stateFingerprint = (store, id) =>
    createHash('sha256')
        .update(JSON.stringify(store.load(id)))
        .digest('hex')

const wireFingerprint = (frame) =>
    `${frame.id}/${frame.seq}/${frame.raw.length}/${createHash('sha256').update(frame.raw).digest('hex')}`

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-gcm-network-'))
    const clients = [],
        warnings = []
    let server
    try {
        server = await startServer(
            {
                ...configuration(),
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                database: path.join(directory, 'network.sqlite'),
                diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                crcDelay: 0,
                strongEncryption: true,
                stateFlushMs: 60000,
                entryWorldChatNoticeDelayMs: 3600000,
            },
            {
                info() {},
                warn(line) {
                    warnings.push(line)
                },
            },
        )
        server.game.clock = () => 1800000000
        assert.equal(server.tcp.address().address, '127.0.0.1')
        assert.equal(server.web.address().address, '127.0.0.1')
        assert.notEqual(server.tcp.address().port, server.web.address().port)
        const connect = async () => {
            const client = await connectObtGcmClient(server)
            clients.push(client)
            return client
        }
        await run({ server, connect, warnings })
    } finally {
        for (const client of clients) await client.close()
        if (server) await server.close()
        const prefix = path.resolve(os.tmpdir()) + path.sep + 'lurukaps-gcm-network-'
        assert(path.resolve(directory).startsWith(prefix))
        for (const name of fs.readdirSync(directory)) {
            assert(['network.sqlite', 'network.sqlite-journal', 'diagnostics.jsonl'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
}

test(
    'current v3 TCP token transition, hello retry, GCM re-enter, weak ping and new ephemeral reconnect',
    { timeout: 60000 },
    async () => {
        await fixture(async ({ server, connect, warnings }) => {
            const client = await connect()
            const first = await client.login('gcm-network-current')
            assert.equal(first.entered.frame.error, 0)
            assert.equal(first.entered.data.player_id, first.playerId)
            const firstToken = await client.wait(5014)
            await client.wait(server.protocol.byName.get('CSProtoChatMsgCntSync').id)
            assert.equal(firstToken.flag, 0)
            assert.equal(firstToken.raw[4], 0)
            assert.equal(first.entered.frame.flag & 6, 4)
            assert(
                client.trace.some(
                    (frame) => frame.id === server.protocol.byName.get('CSProtoChatMsgCntSync').id && frame.flag & 4,
                ),
            )
            const cipher = client.cipher
            const publicKey = client.serverPublicKey
            const initialState = stateFingerprint(server.store, first.playerId)
            client.socket.write(first.entered.request.raw)
            const retriedToken = await client.wait(5014)
            assert.deepEqual(retriedToken.raw, firstToken.raw, 'retry uses cached original weak token')
            assert.equal(client.cipher, cipher, 'duplicate token must not reinstall/reset cipher')
            assert.deepEqual(client.serverPublicKey, publicKey)
            // The sync optimizer appends deltas after ChatMsgCntSync; the replay token marks the true batch boundary.
            const replayStart = client.trace.indexOf(retriedToken)
            const initialBatch = client.trace.slice(client.trace.indexOf(firstToken), replayStart)
            await client.until(() => client.trace.length >= replayStart + initialBatch.length)
            assert.deepEqual(
                client.trace.slice(replayStart, replayStart + initialBatch.length).map(wireFingerprint),
                initialBatch.map(wireFingerprint),
                'retry restores the cached absolute initial batch without re-sealing',
            )
            const firstPing = await client.barrier()
            const lastInitialSequence = initialBatch
                .filter((frame) => frame.flag & 4)
                .at(-1)
                .raw.readBigUInt64BE(25)
            assert.equal(firstPing.frame.raw.readBigUInt64BE(25), lastInitialSequence + 1n)
            assert.equal(
                stateFingerprint(server.store, first.playerId),
                initialState,
                'replay must not grant, debit or rewrite player state',
            )
            const beforeUsage = cipher.usage.sequence
            const noHello = { ...first.enterValue }
            delete noHello.crypto_version
            delete noHello.client_public_key
            const reentered = await client.call('EnterGame', noHello)
            assert.equal(
                reentered.frame.error,
                ErrorCode.InvalidArgument,
                'existing entered-session business guard is preserved',
            )
            assert.equal(reentered.request.raw[4], 4)
            assert.equal(reentered.frame.flag, 4)
            assert.equal(reentered.request.raw.readBigUInt64BE(25), beforeUsage)
            assert.equal(client.cipher, cipher)
            assert.equal(client.trace.filter((frame) => frame.id === 5014).length, 2)
            const weakPing = await client.barrier({ weak: true })
            assert.equal(weakPing.request.raw[4], 0)
            assert.equal(weakPing.frame.flag, 4)
            const changed = await client.call('ChangeSign', {
                sign: Buffer.from('v3 state persists').toString('base64'),
            })
            assert.equal(changed.request.raw[4], 4)
            assert.equal(changed.frame.flag, 4)
            assert.equal(changed.frame.error, 0)
            const savedSign = server.store.load(first.playerId).state.player.basic_info.sign
            await client.close()
            const reconnect = await connect()
            const second = await reconnect.login('gcm-network-current', { reconnect: true })
            assert.equal(second.entered.frame.error, 0)
            await reconnect.barrier()
            assert.equal(second.playerId, first.playerId)
            assert.notDeepEqual(reconnect.clientPublicKey, client.clientPublicKey)
            assert.notDeepEqual(reconnect.serverPublicKey, publicKey)
            assert.equal(reconnect.trace.find((frame) => frame.flag & 4).raw.readBigUInt64BE(25), 0n)
            assert.equal(server.store.load(first.playerId).state.player.basic_info.sign, savedSign)
            assert.equal(
                warnings.some((line) => line.startsWith('Framing:')),
                false,
            )
        })
    },
)

test(
    'invalid v3 version/key and authenticated-frame tamper/mixed flags do not commit player changes',
    { timeout: 60000 },
    async () => {
        await fixture(async ({ server, connect }) => {
            for (const [suffix, overrides] of [
                ['version', { crypto_version: 4 }],
                ['short-key', { client_public_key: Buffer.alloc(31, 7).toString('base64') }],
                ['low-order-key', { client_public_key: Buffer.alloc(32).toString('base64') }],
            ]) {
                const client = await connect()
                const login = await client.call('Login', { open_id: `gcm-bad-${suffix}`, app_version: '1.0.0' })
                assert.equal(login.frame.error, 0)
                const before = stateFingerprint(server.store, login.data.pid)
                const request = client.encode('EnterGame', {
                    open_id: `gcm-bad-${suffix}`,
                    app_version: '1.0.0',
                    server_token: login.data.server_token,
                    crypto_version: 3,
                    client_public_key: client.clientPublicKey.toString('base64'),
                    ...overrides,
                })
                client.socket.write(request.raw)
                const rejected = await client.wait(request.id, request.seq)
                assert.equal(rejected.error, ErrorCode.InvalidArgument)
                assert.equal(stateFingerprint(server.store, login.data.pid), before)
                assert.equal(
                    client.trace.some((frame) => frame.id === 5014 || frame.id === 10006),
                    false,
                )
            }
            for (const kind of ['tag', 'aad', 'mixed-flags']) {
                const client = await connect()
                const login = await client.login(`gcm-corrupt-${kind}`)
                assert.equal(login.entered.frame.error, 0)
                await client.barrier()
                const before = stateFingerprint(server.store, login.playerId)
                const request = client.encode('ChangeSign', {
                    sign: Buffer.from('must never commit').toString('base64'),
                })
                assert.equal(request.raw[4], 4)
                if (kind === 'tag') request.raw[request.raw.length - 1] ^= 1
                if (kind === 'aad') request.raw[17] ^= 1
                if (kind === 'mixed-flags') request.raw[4] |= 2
                client.socket.write(request.raw)
                await client.closed()
                assert.equal(stateFingerprint(server.store, login.playerId), before)
            }
        })
    },
)
