import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { requestCrc } from '../src/wire-crc.js'
import { decompressLz4 } from '../src/compression.js'
import { connectObtGcmClient } from './helpers/obt-gcm-client.js'

// One exact current CSAddChat vector: literals(prefix+one A), offset1 match1530, literals(five A+suffix).
// This is a deterministic raw LZ4 fixture, not a competing general compressor.
const chatValue = { target: { tid: '1', chat_type: 2 }, msg: Buffer.alloc(1536, 65).toString('base64'), type: 0 }
const chatPayload = Buffer.concat([
    Buffer.from('0a040801100212800c', 'hex'),
    Buffer.alloc(1536, 65),
    Buffer.from('1800', 'hex'),
])
const chatBlock = Buffer.from('af0a040801100212800c410100ffffffffffec7041414141411800', 'hex')
const fingerprint = (server, id) =>
    createHash('sha256')
        .update(JSON.stringify(server.store.load(id)))
        .digest('hex')
const chatCount = (server) => server.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-gcm-crc-'))
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
                crcDelay: 2,
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
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-gcm-crc-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['network.sqlite', 'network.sqlite-journal', 'diagnostics.jsonl'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
}

test(
    'current D2 installs at5011, warms by full sends, retries with new CRC, and authenticates raw-LZ4 flag5',
    { timeout: 60000 },
    async () => {
        assert.deepEqual(decompressLz4(chatBlock), chatPayload)
        assert(chatBlock.length < chatPayload.length && chatPayload.length >= 1024)
        await fixture(async ({ server, connect, warnings }) => {
            const client = await connect()
            const login = await client.login('gcm-crc-compressed-current')
            assert.equal(login.entered.frame.error, 0)
            const callback = await client.wait(5011)
            assert.equal(server.protocol.decode(server.protocol.byId.get(5011).rsp, callback.payload).crc_rand_index, 2)
            assert.deepEqual(client.crc, { delay: 2, queue: [] }, 'Login/hello complete before5011 with initial D0')
            const firstRequest = client.encode('Ping', { client_ts: '101' })
            assert.deepEqual(client.crc.queue, [], 'Pack alone must not enqueue CRC')
            const sending = client.transmit(firstRequest, { fragment: true })
            assert.deepEqual(client.crc.queue, [], 'partial frame writes must not enqueue CRC')
            await sending
            const first = { request: firstRequest, frame: await client.wait(firstRequest.id, firstRequest.seq) }
            assert.equal(first.frame.error, 0)
            assert.equal(first.request.error, 0)
            assert.deepEqual(client.crc.queue, [first.request.newCrc])
            const second = await client.call('Ping', { client_ts: '102' })
            assert.equal(second.frame.error, 0)
            assert.equal(second.request.error, first.request.newCrc)
            assert.notEqual(first.request.newCrc, second.request.newCrc)
            assert.deepEqual(client.crc.queue, [first.request.newCrc, second.request.newCrc])
            const before = chatCount(server)
            const chat = await client.call('AddChat', chatValue, { compressedPayload: chatBlock })
            assert.equal(chat.frame.error, 0)
            assert.deepEqual(chat.request.payload, chatPayload)
            assert.equal(chat.request.raw[4], 5)
            assert.equal(chat.request.raw.length, 25 + 24 + chatBlock.length)
            assert.equal(chat.request.raw.readUInt16BE(7), first.request.newCrc)
            assert.notEqual(chat.request.newCrc, requestCrc({ ...chat.request, payload: chatBlock }))
            assert.deepEqual(client.crc.queue, [second.request.newCrc, chat.request.newCrc])
            assert.equal(chatCount(server), before + 1)
            const afterChat = fingerprint(server, login.playerId)
            const retry = await client.call('AddChat', {}, { retryOf: chat.request, compressedPayload: chatBlock })
            assert.equal(retry.frame.error, 0)
            assert.equal(retry.request.seq, chat.request.seq)
            assert.equal(retry.request.raw.readUInt16BE(7), second.request.newCrc)
            assert.notEqual(retry.request.error, chat.request.error)
            assert.equal(retry.request.raw.readBigUInt64BE(25), chat.request.raw.readBigUInt64BE(25) + 1n)
            assert.equal(retry.request.newCrc, chat.request.newCrc)
            assert.deepEqual(retry.frame.raw, chat.frame.raw, 'business reply uses original cached ciphertext')
            assert.equal(chatCount(server), before + 1)
            assert.equal(fingerprint(server, login.playerId), afterChat)
            assert.deepEqual(client.crc.queue, [chat.request.newCrc, chat.request.newCrc])
            const following = await client.call('Ping', { client_ts: '103' })
            assert.equal(following.frame.error, 0)
            assert.equal(
                following.request.error,
                chat.request.newCrc,
                'server CRC queue must contain decompressed protobuf CRC',
            )
            assert.equal(
                warnings.some((line) => line.startsWith('Framing:')),
                false,
            )
        })
    },
)

test(
    'authenticated wrong delayed CRC and tag-corrupt compressed requests never append chat or write state',
    { timeout: 60000 },
    async () => {
        await fixture(async ({ server, connect, warnings }) => {
            for (const kind of ['crc', 'tag']) {
                const client = await connect()
                const login = await client.login(`gcm-crc-reject-${kind}`)
                assert.equal(login.entered.frame.error, 0)
                await client.barrier()
                assert.equal(client.crc.delay, 2)
                assert.equal(client.crc.queue.length, 1)
                const before = fingerprint(server, login.playerId),
                    beforeChat = chatCount(server)
                const request = client.encode('AddChat', chatValue, {
                    compressedPayload: chatBlock,
                    ...(kind === 'crc' ? { crcOverride: client.crc.queue[0] ^ 0xffff } : {}),
                })
                assert.equal(request.raw[4], 5)
                if (kind === 'tag') request.raw[request.raw.length - 1] ^= 1
                await client.transmit(request)
                await client.closed()
                assert.equal(fingerprint(server, login.playerId), before)
                assert.equal(chatCount(server), beforeChat)
            }
            assert(warnings.some((line) => line.includes('Delayed request CRC mismatch')))
        })
    },
)
