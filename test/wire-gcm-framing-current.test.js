import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { encodeFrame, decodeFrame, FrameReader, PEER_MAX_FRAME } from '../src/wire.js'
import { GateGcmCipher } from '../src/wire-gcm.js'
import { compressLz4 } from '../src/compression.js'

const material = Buffer.from(Array.from({ length: 40 }, (_, i) => i + 1))
const legacyKey = Buffer.from('public-test-legacy-key')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

for (const mode of ['weak', 'rc4', 'gcm'])
    test(`current raw LZ4 is selected before ${mode} protection and preserves the original payload`, () => {
        const payload = Buffer.alloc(2 * 1024 * 1024, 65),
            before = Buffer.from(payload),
            server = new GateGcmCipher(material),
            client = new GateGcmCipher(material, { role: 'client' }),
            send = mode === 'gcm' ? { gcmCipher: server } : { encryptionKey: legacyKey },
            receive = mode === 'gcm' ? { gcmCipher: client } : { encryptionKey: legacyKey }
        try {
            const raw = encodeFrame(
                { id: 5001, seq: 0x12345678, flag: mode === 'rc4' ? 2 : 0, signature: 0x123456789abcdef0n },
                payload,
                send,
            )
            assert(raw.length <= PEER_MAX_FRAME)
            assert.equal(raw[4], mode === 'gcm' ? 5 : mode === 'rc4' ? 3 : 1)
            const frame = decodeFrame(raw, receive)
            assert.equal(frame.seq, 0x12345678)
            assert.equal(frame.signature, 0x123456789abcdef0n)
            assert.equal(frame.payload.length, before.length)
            assert.equal(digest(frame.payload), digest(before))
            assert.equal(digest(payload), digest(before))
            // A caller's already-compressed block is not compressed twice.
            const block = compressLz4(Buffer.alloc(4096, 66))
            const packed = encodeFrame({ id: 503, flag: mode === 'rc4' ? 3 : 1 }, block, send)
            assert.deepEqual(decodeFrame(packed, receive).payload, Buffer.alloc(4096, 66))
        } finally {
            server.dispose()
            client.dispose()
        }
    })

test('incompressible oversized output is rejected before consuming a Gate nonce', () => {
    const server = new GateGcmCipher(material),
        payload = Buffer.alloc(PEER_MAX_FRAME + 65536)
    let value = 0x12345678
    for (let i = 0; i < payload.length; i++) {
        value ^= value << 13
        value ^= value >>> 17
        value ^= value << 5
        payload[i] = value >>> 24
    }
    try {
        for (const options of [{}, { encryptionKey: legacyKey }, { gcmCipher: server }])
            assert.throws(
                () => encodeFrame({ id: 503, flag: options.encryptionKey ? 2 : 0 }, payload, options),
                /peer size limit/,
            )
        assert.deepEqual(server.usage, { sequence: 0n, blocks: 0n })
    } finally {
        server.dispose()
    }
})

test('one coalesced chunk installs the token cipher before later GCM frames and rejects invalid flag combinations', () => {
    const server = new GateGcmCipher(material),
        client = new GateGcmCipher(material, { role: 'client' }),
        reader = new FrameReader(),
        token = encodeFrame({ id: 5014 }, Buffer.from('public-handshake-fixture')),
        tail = encodeFrame({ id: 503, seq: 2 }, Buffer.from('ready'), { gcmCipher: server })
    try {
        const frames = reader.feed(Buffer.concat([token, tail]), (frame) => {
            if (frame.id === 5014) reader.setGcmCipher(client)
        })
        assert.equal(frames.length, 2)
        assert.equal(frames[1].flag, 4)
        assert.equal(frames[1].payload.toString(), 'ready')
        reader.setGcmCipher(client)
        assert.throws(() => reader.setEncryptionKey(legacyKey), /cannot change/)
        const mixed = Buffer.from(tail)
        mixed[4] = 6
        assert.throws(() => decodeFrame(mixed, { gcmCipher: client }), /Mixed RC4/)
        const unknown = Buffer.from(tail)
        unknown[4] = 16
        assert.throws(() => decodeFrame(unknown, { gcmCipher: client }), /Unsupported frame flags/)
    } finally {
        server.dispose()
        client.dispose()
    }
})
