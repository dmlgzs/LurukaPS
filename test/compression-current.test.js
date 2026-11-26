import test from 'node:test'
import assert from 'node:assert/strict'
import { compressLz4, decompressLz4 } from '../src/compression.js'

function randomBytes(length, seed) {
    const bytes = Buffer.alloc(length)
    let value = seed >>> 0
    for (let i = 0; i < length; i++) {
        value ^= value << 13
        value ^= value >>> 17
        value ^= value << 5
        bytes[i] = value & 255
    }
    return bytes
}
function distanceSample(distance) {
    return Buffer.concat([
        Buffer.from([251, 252, 253, 254]),
        Buffer.alloc(distance - 4),
        Buffer.from([251, 252, 253, 254, 81, 82, 83, 84, 85, 86, 87, 88]),
    ])
}

// Exported only so the external liblz4 oracle can consume precisely the same
// deterministic samples. Normal tests need no native/Python dependency.
export function compressionCurrentSamples() {
    const samples = [
        { name: 'distance65535', input: distanceSample(65535) },
        { name: 'distance65536', input: distanceSample(65536) },
        { name: 'four-megabytes-overlap', input: Buffer.alloc(4 * 1024 * 1024, 97) },
        { name: 'large-incompressible', input: randomBytes(1024 * 1024, 0x7fbc85) },
    ]
    for (const size of [
        0, 1, 4, 5, 11, 12, 13, 14, 15, 16, 19, 20, 254, 255, 269, 270, 271, 510, 525, 1023, 1024, 65534, 65535, 65536,
        65537,
    ])
        for (const [kind, input] of [
            ['random', randomBytes(size, size + 17)],
            ['overlap', Buffer.alloc(size, size & 255)],
            ['periodic', Buffer.from('abcdefghijk'.repeat(Math.ceil(size / 11))).subarray(0, size)],
        ])
            samples.push({ name: `${kind}-${size}`, input })
    for (let seed = 1; seed <= 250; seed++) {
        const size = (seed * 1543) % 20000,
            input = randomBytes(size, seed)
        if (seed % 3 === 0) input.fill(seed & 255, Math.floor(size / 4), Math.floor((size * 3) / 4))
        if (seed % 5 === 0) input.copy(input, Math.floor(size / 2), 0, Math.floor(size / 2))
        samples.push({ name: `seed-${seed}`, input })
    }
    return samples
}

// Structural parser deliberately does not perform match copying. Check the
// format restrictions independently of the existing permissive decoder.
function inspectBlock(bytes) {
    let cursor = 0,
        decoded = 0
    const sequences = []
    const length = (n) => {
        if (n < 15) return n
        let extra
        do {
            assert(cursor < bytes.length)
            extra = bytes[cursor++]
            n += extra
        } while (extra === 255)
        return n
    }
    while (cursor < bytes.length) {
        const token = bytes[cursor++],
            literals = length(token >>> 4),
            literalStart = cursor
        cursor += literals
        assert(cursor <= bytes.length)
        decoded += literals
        if (cursor === bytes.length) {
            assert.equal(token & 15, 0)
            sequences.push({ literals, literalStart, final: true })
            break
        }
        assert(cursor + 2 <= bytes.length)
        const offset = bytes.readUInt16LE(cursor)
        cursor += 2
        assert(offset > 0 && offset <= Math.min(decoded, 65535))
        const match = length(token & 15) + 4
        sequences.push({ literals, offset, match, start: decoded })
        decoded += match
    }
    assert(sequences.at(-1)?.final)
    assert(sequences.at(-1).literals >= Math.min(decoded, 5))
    for (const sequence of sequences.filter((sequence) => !sequence.final)) assert(sequence.start <= decoded - 12)
    return { sequences, decoded }
}

test('raw encoder matches independently generated liblz4 1.10.0 vectors without a size prefix or frame header', () => {
    // Obtained via installed msys-lz4-1.dll LZ4_compress_default, not this encoder.
    const vectors = [
        [Buffer.alloc(0), '00'],
        [Buffer.from('abcdefghijklmno'), 'f0006162636465666768696a6b6c6d6e6f'],
        [Buffer.alloc(13, 97), '13610100506161616161'],
        [Buffer.from('abc'.repeat(100)), '3f6162630300ff12506263616263'],
        [Buffer.alloc(1024, 98), '1f620100ffffffea506262626262'],
    ]
    for (const [input, hex] of vectors) {
        assert.equal(compressLz4(input).toString('hex'), hex)
        assert.deepEqual(decompressLz4(Buffer.from(hex, 'hex'), Math.max(1, input.length)), input)
    }
})

test('deterministic mixed samples satisfy raw-block termination, length extensions, overlap and round-trip bounds', () => {
    for (const { name, input } of compressionCurrentSamples()) {
        const before = Buffer.from(input),
            encoded = compressLz4(input),
            inspected = inspectBlock(encoded)
        assert.equal(inspected.decoded, input.length, name)
        assert.deepEqual(decompressLz4(encoded, Math.max(1, input.length)), input, name)
        assert.deepEqual(input, before, 'Input must remain unchanged: ' + name)
        assert.deepEqual(compressLz4(input), encoded, 'Output is deterministic: ' + name)
    }
})

test('65535-byte offsets are encodable while65536-byte references cannot leak into the raw block', () => {
    const atLimit = inspectBlock(compressLz4(distanceSample(65535)))
    assert(atLimit.sequences.some((sequence) => sequence.offset === 65535))
    const outside = inspectBlock(compressLz4(distanceSample(65536)))
    assert(outside.sequences.every((sequence) => !sequence.offset || sequence.offset <= 65535))
    assert.deepEqual(decompressLz4(compressLz4(distanceSample(65536)), 70000), distanceSample(65536))
})

test('output caps reject partial blocks, byte views stay within their slice and incompressible data may grow', () => {
    const random = randomBytes(1024, 12345),
        encoded = compressLz4(random)
    assert(encoded.length > random.length, 'The caller, rather than encoder, decides whether to use compression')
    assert.deepEqual(compressLz4(random, encoded.length), encoded)
    assert.throws(() => compressLz4(random, encoded.length - 1), /output limit/)
    assert.throws(() => compressLz4(Buffer.alloc(0), 0), /output limit/)
    assert.equal(compressLz4(Buffer.alloc(0), 1).toString('hex'), '00')
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => compressLz4(random, limit), /output limit/)
    for (const value of [null, 'bytes', [], {}, new DataView(new ArrayBuffer(8))])
        assert.throws(() => compressLz4(value), /must be bytes/)
    const backing = Uint8Array.from([7, 8, ...Buffer.from('abc'.repeat(40)), 9, 10]),
        original = Uint8Array.from(backing),
        view = backing.subarray(2, -2)
    assert.deepEqual(decompressLz4(compressLz4(view), view.length), Buffer.from(view))
    assert.deepEqual(backing, original)
})

test('existing decoder keeps its original overlap and malformed-block behavior', () => {
    assert.equal(decompressLz4(Buffer.from([0x32, 97, 98, 99, 3, 0, 0x10, 33]), 100).toString(), 'abcabcabc!')
    assert.throws(() => decompressLz4(Buffer.from([0, 0, 0])))
    assert.throws(() => decompressLz4(Buffer.from([0xf0])))
    assert.throws(() => decompressLz4(Buffer.from([0x32, 97, 98, 99, 3, 0]), 8))
})
