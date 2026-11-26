import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { crcModbus, requestCrc, DelayedCrc } from '../src/wire-crc.js'
import { encodeFrame, decodeFrame, FrameReader } from '../src/wire.js'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
test('request CRC is MODBUS over uncompressed bytes from offset 9', () => {
    assert.equal(crcModbus(Buffer.from('123456789')), 0x4b37)
    const a = {
        id: 503,
        error: 55,
        flag: 0,
        seq: 0x12345678,
        pushSeq: 0xabcdef01,
        signature: 0xfedcba9876543210n,
        payload: Buffer.from('abcabcabc!'),
    }
    assert.equal(
        requestCrc(a),
        crcModbus(Buffer.from('12345678abcdef01fedcba9876543210' + '61626361626361626321', 'hex')),
    )
    assert.equal(requestCrc({ ...a, id: 5002, error: 999, flag: 3 }), requestCrc(a))
    assert.notEqual(requestCrc({ ...a, signature: 2n }), requestCrc(a))
    const compressed = decodeFrame(encodeFrame({ ...a, flag: 1 }, Buffer.from([0x32, 97, 98, 99, 3, 0, 0x10, 33])))
    assert.equal(requestCrc(compressed), requestCrc(a))
})
test('delayed CRC queue peeks before packing and advances every transmission', () => {
    const queue = new DelayedCrc(2),
        frame = (seq) => ({ seq, pushSeq: 0, payload: Buffer.from([seq]), error: 0 })
    const a = frame(1),
        b = frame(2),
        c = frame(3)
    queue.accept(a)
    b.error = requestCrc(a)
    queue.accept(b)
    c.error = requestCrc(a)
    queue.accept(c)
    const repeat = { ...c, error: requestCrc(b) }
    queue.accept(repeat)
    const before = [...queue.queue]
    assert.throws(() => queue.accept({ ...frame(4), error: requestCrc(a) }), /CRC mismatch/)
    assert.deepEqual(queue.queue, before)
    queue.accept({ ...frame(4), error: requestCrc(c) })
    const zero = new DelayedCrc()
    zero.accept({ ...frame(1), error: 888 })
    assert.deepEqual(zero.queue, [])
    for (const value of [-1, 65, 1.1, NaN]) assert.throws(() => new DelayedCrc(value))
})
for (const strongEncryption of [false, true])
    test('TCP delayed CRC, retry and corruption rejection; strong encryption=' + strongEncryption, async () => {
        const logs = [],
            server = await startServer(
                { ...configuration(), gamePort: 0, httpPort: 0, database: ':memory:', crcDelay: 2, strongEncryption },
                { warn: (s) => logs.push(s) },
            )
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let wake, key
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
        async function response(id) {
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
        }
        const make = (name, data, seq, error = 0) => {
            const e = server.protocol.byName.get('CSProto' + name)
            return { id: e.id, seq, pushSeq: 0, signature: 0n, error, payload: server.protocol.encode(e.req, data) }
        }
        const send = (f) => socket.write(encodeFrame({ ...f, flag: key ? 2 : 0 }, f.payload, { encryptionKey: key }))
        try {
            await once(socket, 'connect')
            send(make('EnterGame', { open_id: 'crc-player' }, 1))
            const start = await response(5011)
            assert.equal(server.protocol.decode('SCEnterGameCallbackStart', start.payload).crc_rand_index, 2)
            const enter = await response(5001),
                pid = server.protocol.decode('SCEnterGame', enter.payload).player_id
            const a = make('Ping', { client_ts: '111' }, 2)
            send(a)
            await response(503)
            const b = make('Ping', { client_ts: '222' }, 3, requestCrc(a))
            send(b)
            const first = await response(503)
            assert.equal(first.error, 0)
            assert.equal(first.seq, 3)
            assert.equal(server.protocol.decode('SCPing', first.payload).client_ts, '222')
            send({ ...b, error: requestCrc(a) })
            assert.deepEqual(await response(503), first)
            const before = server.store.load(pid)
            const closed = once(socket, 'close')
            send(make('ChangeName', { name: Buffer.from('bad-crc').toString('base64') }, 4, requestCrc(b) ^ 0xffff))
            await closed
            assert.deepEqual(server.store.load(pid), before)
            assert(logs.some((x) => x.includes('Delayed request CRC mismatch')))
        } finally {
            socket.destroy()
            await server.close()
        }
    })
