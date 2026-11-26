import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { strongTransform } from '../src/wire-crypto.js'
import { encodeFrame, decodeFrame, FrameReader } from '../src/wire.js'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
test('CBT3 per-packet RC4 matches independent published primitive vector', () => {
    const key = Buffer.from('Key'),
        plain = Buffer.from('Plaintext')
    assert.equal(strongTransform(Buffer.from(plain), key, 0).toString('hex'), 'bbf316e8d940af0ad3')
    const frame = encodeFrame(
        { id: 503, seq: 0xfedcba98, pushSeq: 0x12345678, signature: 0xfedcba9876543210n, flag: 2 },
        plain,
        { encryptionKey: key },
    )
    assert.equal(frame.subarray(0, 7).toString('hex'), '000000220201f7')
    assert.equal(decodeFrame(frame, { encryptionKey: key }).payload.toString(), 'Plaintext')
    assert.deepEqual(
        encodeFrame({ id: 503, seq: 0xfedcba98, pushSeq: 0x12345678, signature: 0xfedcba9876543210n, flag: 2 }, plain, {
            encryptionKey: key,
        }),
        frame,
    )
    assert.throws(() => decodeFrame(frame), /nonempty byte key/)
    assert.throws(() => decodeFrame(frame, { encryptionKey: Buffer.alloc(0) }), /nonempty byte key/)
})
test('encrypted compression and key transition within one TCP chunk', () => {
    const key = Buffer.from('transition-key'),
        token = encodeFrame({ id: 5014 }, key)
    const compressed = encodeFrame(
        { id: 503, flag: 3, seq: 0xffffffff },
        Buffer.from([0x32, 97, 98, 99, 3, 0, 0x10, 33]),
        { encryptionKey: key },
    )
    const reader = new FrameReader(),
        frames = reader.feed(Buffer.concat([token, compressed]), (frame) => {
            if (frame.id === 5014) reader.setEncryptionKey(frame.payload)
        })
    assert.equal(frames[1].payload.toString(), 'abcabcabc!')
    assert.equal(frames[1].seq, 0xffffffff)
    reader.setEncryptionKey(null)
    assert.throws(() => reader.feed(compressed), /nonempty byte key/)
})
test('TCP negotiates independent keys, encrypted requests, errors and exact retries', async () => {
    const logs = [],
        server = await startServer(
            { ...configuration(), gamePort: 0, httpPort: 0, database: ':memory:', strongEncryption: true },
            { warn: (s) => logs.push(s) },
        )
    const clients = []
    function client() {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let key, wake
        const c = {
            socket,
            reader,
            queue,
            get key() {
                return key
            },
            async response(id) {
                const end = Date.now() + 5000
                while (Date.now() < end) {
                    const i = queue.findIndex((x) => x.id === id)
                    if (i >= 0) return queue.splice(i, 1)[0]
                    await new Promise((resolve) => {
                        const t = setTimeout(resolve, 100)
                        wake = () => {
                            clearTimeout(t)
                            resolve()
                        }
                    })
                }
                throw Error('Missing ' + id)
            },
            send(name, data, seq) {
                const e = server.protocol.byName.get('CSProto' + name)
                const packet = encodeFrame(
                    { id: e.id, seq, flag: key && e.id !== 5001 ? 2 : 0 },
                    server.protocol.encode(e.req, data),
                    { encryptionKey: key },
                )
                socket.write(packet)
                return packet
            },
        }
        socket.on('data', (chunk) => {
            reader.feed(chunk, (frame) => {
                if (frame.id === 5014) {
                    key = Buffer.from(server.protocol.decode('SCEnterGameToken', frame.payload).rc4_key, 'base64')
                    reader.setEncryptionKey(key)
                }
                queue.push(frame)
            })
            wake?.()
        })
        clients.push(c)
        return c
    }
    try {
        const a = client()
        await once(a.socket, 'connect')
        a.send('EnterGame', { open_id: 'strong-player-a' }, 1)
        const enter = await a.response(5001)
        assert.equal(enter.error, 0)
        assert.equal(a.key.length, 32)
        const token = await a.response(5014)
        assert.equal(token.flag, 0)
        assert.equal((await a.response(5011)).flag & 6, 2)
        const request = a.send('Ping', { client_ts: '789' }, 2),
            ping = await a.response(503)
        assert.equal(ping.flag & 6, 2)
        assert.equal(server.protocol.decode('SCPing', ping.payload).client_ts, '789')
        a.socket.write(request)
        assert.deepEqual(await a.response(503), ping)
        a.socket.write(encodeFrame({ id: 65500, seq: 3, flag: 2 }, Buffer.alloc(0), { encryptionKey: a.key }))
        const error = await a.response(65500)
        assert.equal(error.flag & 6, 2)
        assert.equal(error.error, ErrorCode.InvalidProtoID)
        const b = client()
        await once(b.socket, 'connect')
        b.send('EnterGame', { open_id: 'strong-player-b' }, 1)
        await b.response(5001)
        assert.notDeepEqual(a.key, b.key)
        b.send('Ping', { client_ts: '456' }, 2)
        assert.equal(server.protocol.decode('SCPing', (await b.response(503)).payload).client_ts, '456')
    } finally {
        for (const c of clients) c.socket.destroy()
        await server.close()
    }
})
