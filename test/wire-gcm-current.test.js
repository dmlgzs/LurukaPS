import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
const vectors = {
    clientPrivate: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    serverPrivate: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
    clientPublic: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    serverPublic: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    sharedSecret: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    transcript:
        '00186d616e6a75752f676174652d68616e647368616b652f7633000000038520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6ade9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    salt: '545ffefddf0eaeb79252d9eb766c314e1aa8368fd51cedc824d347b6c497d3a2',
    material: '7f48b1575aee169b2bebe165cf5e440c97295d6b4c6b04ba08cdd22c1d4692f446cf6b7dd6dd74cc',
    cases: [
        {
            flag: 0,
            payload: '',
            clearFrame: '00000019001389040012345678abcdef01fedcba9876543210',
            wireFrame:
                '00000031041389040012345678abcdef01fedcba98765432100000000000000000ca148c73143811e9424aebc1f6114011',
            role: 'client',
            nonce: '97295d6b0000000000000000',
            sequence: '0',
        },
        {
            flag: 1,
            payload: '42626c6f636b007769746820636f6d70726573736564206279746573',
            clearFrame:
                '00000035011389040012345678abcdef01fedcba987654321042626c6f636b007769746820636f6d70726573736564206279746573',
            wireFrame:
                '0000004d051389040012345678abcdef01fedcba98765432100000000000000001f1e19e4a79c395f8f89be4ff3f882731f5902657adc255a39d7ffd3926bb8b00408696bac5b73926f3b5363f',
            role: 'client',
            nonce: '97295d6b0000000000000001',
            sequence: '1',
        },
        {
            flag: 16,
            payload: '080110021a03616263',
            clearFrame: '00000022101389040012345678abcdef01fedcba9876543210080110021a03616263',
            wireFrame:
                '0000003a041389040012345678abcdef01fedcba98765432100000000000000000cef944baa2aff544afedb28aa5ee9e3a7935384c53b104fbb4',
            role: 'server',
            nonce: 'd6dd74cc0000000000000000',
            sequence: '0',
        },
        {
            flag: 1,
            payload: '00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f10',
            clearFrame:
                '0000003a011389040012345678abcdef01fedcba987654321000112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f10',
            wireFrame:
                '00000052051389040012345678abcdef01fedcba9876543210000000000000000182ff278143acdb97849614a1b7b7b47f1ccc48db48318f1c673cbcc64f21e1dc23cc61f377d5c143323bbe9ee48671a13e',
            role: 'server',
            nonce: 'd6dd74cc0000000000000001',
            sequence: '1',
        },
        {
            flag: 0,
            payload: '616263',
            clearFrame: '0000001c001389040012345678abcdef01fedcba9876543210616263',
            wireFrame:
                '00000034041389040012345678abcdef01fedcba987654321001020304050607088d533ce5d54a510219dd32b5207b82f67b1790',
            role: 'client',
            nonce: '97295d6b0102030405060708',
            sequence: '72623859790382856',
        },
    ],
    oracle: 'Python RFC7748 ladder + hashlib/hmac HKDF; Windows .NET System.Security.Cryptography.AesGcm',
}
import { createGateServerHandshake, deriveGateMaterial } from '../src/wire-ecdh.js'
import { GateGcmCipher, GATE_GCM_USAGE_LIMIT, gateGcmUsageAfterSeal } from '../src/wire-gcm.js'

const bytes = (hex) => Buffer.from(hex, 'hex')
const material = bytes(vectors.material)

test('current v3 X25519 and reserved-byte HKDF match independent Python known answers', () => {
    const client = bytes(vectors.clientPublic)
    const privateKey = bytes(vectors.serverPrivate)
    const result = createGateServerHandshake(client, { cryptoVersion: 3, privateKey })
    assert.equal(result.serverPublicKey.toString('hex'), vectors.serverPublic)
    assert.equal(result.material.toString('hex'), vectors.material)
    assert.equal(privateKey.toString('hex'), vectors.serverPrivate)
    assert.equal(client.toString('hex'), vectors.clientPublic)
    const secret = bytes(vectors.sharedSecret)
    assert.deepEqual(deriveGateMaterial(secret, client, result.serverPublicKey), material)
    assert.equal(secret.toString('hex'), vectors.sharedSecret)
    assert.equal(bytes(vectors.transcript).length, 94)
    assert.equal(bytes(vectors.transcript).subarray(26, 29).toString('hex'), '000000')
    assert.throws(() => createGateServerHandshake(client, { cryptoVersion: 2 }))
    assert.throws(() => createGateServerHandshake(Buffer.alloc(31)))
    assert.throws(() => createGateServerHandshake(client, { privateKey: Buffer.alloc(31) }))
    assert.throws(() => createGateServerHandshake(Buffer.alloc(32)))
    assert.throws(() => deriveGateMaterial(Buffer.alloc(31), client, result.serverPublicKey))
})

test('both directions match independent Windows AES-GCM frames byte for byte', () => {
    for (const role of ['client', 'server']) {
        const cipher = new GateGcmCipher(material, { role })
        const peer = new GateGcmCipher(material, { role: role === 'server' ? 'client' : 'server' })
        for (const vector of vectors.cases.filter((item) => item.role === role && BigInt(item.sequence) < 2n)) {
            const clear = bytes(vector.clearFrame)
            const before = Buffer.from(clear)
            const wire = cipher.seal(clear)
            assert.equal(wire.toString('hex'), vector.wireFrame)
            assert.deepEqual(clear, before)
            assert.equal(wire.length, clear.length + 24)
            assert.equal(wire[4], (vector.flag & 1) | 4)
            assert.equal(wire.readUInt32BE(), wire.length)
            assert.equal(wire.readBigUInt64BE(25), BigInt(vector.sequence))
            assert.equal(peer.open(wire).toString('hex'), vector.payload)
            assert.equal(peer.open(bytes(vector.wireFrame)).toString('hex'), vector.payload)
        }
        assert.equal(cipher.usage.sequence, 2n)
    }
})

test('every header/sequence byte is authenticated along with ciphertext and tag', () => {
    const vector = vectors.cases.find((item) => item.role === 'server' && item.sequence === '1')
    const cipher = new GateGcmCipher(material, { role: 'client' })
    const wire = bytes(vector.wireFrame)
    for (const offset of [...Array(33).keys(), 33, wire.length - 1]) {
        const corrupt = Buffer.from(wire)
        corrupt[offset] ^= 1
        assert.throws(() => cipher.open(corrupt), undefined, `tamper byte ${offset}`)
        assert.equal(cipher.open(wire).toString('hex'), vector.payload)
    }
    assert.throws(() => new GateGcmCipher(material, { role: 'server' }).open(wire))
    const wrong = Buffer.from(material)
    wrong[20] ^= 1
    assert.throws(() => new GateGcmCipher(wrong, { role: 'client' }).open(wire))
    assert.equal(wire.toString('hex'), vector.wireFrame)
})

test('receive follows current Open contract without invented replay or monotonicity rejection', () => {
    const receiver = new GateGcmCipher(material)
    const cases = vectors.cases.filter((item) => item.role === 'client')
    for (const vector of [cases[2], cases[1], cases[0], cases[1], cases[2]])
        assert.equal(receiver.open(bytes(vector.wireFrame)).toString('hex'), vector.payload)
    assert.deepEqual(receiver.usage, { sequence: 0n, blocks: 0n })
})

test('send bounds and block accounting preserve exact native usage limits', () => {
    const cipher = new GateGcmCipher(material, { role: 'client' })
    assert.equal(cipher.seal(Buffer.alloc(262120)).length, 262144)
    const usage = cipher.usage
    assert.throws(() => cipher.seal(Buffer.alloc(262121)))
    assert.throws(() => cipher.seal(Buffer.alloc(24)))
    assert.deepEqual(cipher.usage, usage)
    assert.deepEqual(gateGcmUsageAfterSeal(0n, 0n, 0), { sequence: 1n, blocks: 4n })
    assert.deepEqual(gateGcmUsageAfterSeal(0n, 0n, 1), { sequence: 1n, blocks: 5n })
    assert.equal(gateGcmUsageAfterSeal(0n, 0n, 16).blocks, 5n)
    assert.equal(gateGcmUsageAfterSeal(0n, 0n, 17).blocks, 6n)
    assert.deepEqual(gateGcmUsageAfterSeal(GATE_GCM_USAGE_LIMIT - 1n, GATE_GCM_USAGE_LIMIT - 4n, 0), {
        sequence: GATE_GCM_USAGE_LIMIT,
        blocks: GATE_GCM_USAGE_LIMIT,
    })
    assert.throws(() => gateGcmUsageAfterSeal(GATE_GCM_USAGE_LIMIT, 0n, 0))
    assert.throws(() => gateGcmUsageAfterSeal(0n, GATE_GCM_USAGE_LIMIT - 3n, 0))
    for (const invalid of [-1, 0.5, NaN, 0xffffffff]) assert.throws(() => gateGcmUsageAfterSeal(0n, 0n, invalid))
    assert.throws(() => gateGcmUsageAfterSeal(-1n, 0n, 0))
    const server = new GateGcmCipher(material, { role: 'server', maxSendLength: 300000 })
    assert.equal(server.seal(Buffer.alloc(300000)).length, 300024)
    assert.throws(() => server.seal(Buffer.alloc(300001)))
    assert.throws(() => new GateGcmCipher(material, { role: 'client', maxSendLength: 300000 }))
    assert.throws(() => new GateGcmCipher(material, { maxSendLength: 24 }))
    assert.throws(() => new GateGcmCipher(material, { maxSendLength: 0x100000000 }))
})

test('encryption failure consumes send usage and cannot reuse its nonce', (context) => {
    const cipher = new GateGcmCipher(material)
    const clear = bytes(vectors.cases[0].clearFrame)
    context.mock.method(crypto, 'createCipheriv', () => {
        throw Error('injected standard provider failure')
    })
    syncBuiltinESMExports()
    try {
        assert.throws(() => cipher.seal(clear), /provider failure/)
        assert.deepEqual(cipher.usage, { sequence: 1n, blocks: 4n })
    } finally {
        context.mock.restoreAll()
        syncBuiltinESMExports()
    }
    assert.equal(cipher.seal(clear).readBigUInt64BE(25), 1n)
})

test('key copies, matching and disposal do not allow resetting live usage implicitly', () => {
    const source = Buffer.from(material)
    const cipher = new GateGcmCipher(source)
    source.fill(0)
    assert.equal(cipher.matchesKey(material), true)
    assert.equal(cipher.matchesKey(source), false)
    assert.equal(cipher.matchesKey(Buffer.alloc(39)), false)
    assert.throws(() => new GateGcmCipher(Buffer.alloc(39)))
    assert.throws(() => new GateGcmCipher(material, { role: 'unknown' }))
    assert.throws(() => cipher.open(Buffer.alloc(48)))
    cipher.seal(Buffer.alloc(25))
    const usage = cipher.usage
    usage.sequence = 0n
    assert.equal(cipher.usage.sequence, 1n)
    cipher.dispose()
    cipher.dispose()
    assert.equal(cipher.matchesKey(material), false)
    assert.throws(() => cipher.seal(Buffer.alloc(25)), /disposed/)
    assert.throws(() => cipher.open(bytes(vectors.cases[0].wireFrame)), /disposed/)
})
