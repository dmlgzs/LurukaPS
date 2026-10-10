import { strongTransform } from './wire-crypto.js'
import { decompressLz4 } from './compression.js'
import key from '../configs/wire-key.json' with { type: 'json' }
export const HEADER_SIZE = 25
export const MAX_FRAME = 4 * 1024 * 1024
function transform(buffer) {
    const offset = Math.floor(buffer.length / 3)
    for (let i = 7; i < buffer.length; i++) buffer[i] ^= key[(offset + i - 7) % key.length]
    return buffer
}
export function encodeFrame(
    { id, seq = 0, pushSeq = 0, error = 0, flag = 0, signature = 0n },
    payload = Buffer.alloc(0),
    { encryptionKey } = {},
) {
    const size = HEADER_SIZE + payload.length
    if (size > MAX_FRAME) throw Error('Frame exceeds size limit')
    const b = Buffer.alloc(size)
    b.writeUInt32BE(size)
    b.writeUInt8(flag, 4)
    b.writeUInt16BE(id, 5)
    b.writeUInt16BE(error, 7)
    b.writeUInt32BE(seq, 9)
    b.writeUInt32BE(pushSeq, 13)
    b.writeBigUInt64BE(BigInt(signature), 17)
    payload.copy(b, HEADER_SIZE)
    return flag & 2 ? strongTransform(b, encryptionKey) : transform(b)
}
export function decodeFrame(raw, { encryptionKey } = {}) {
    if (raw.length < HEADER_SIZE || raw.length > MAX_FRAME || raw.readUInt32BE(0) !== raw.length)
        throw Error('Invalid frame size')
    if (raw[4] & ~19) throw Error('Unsupported frame flags')
    const b = raw[4] & 2 ? strongTransform(Buffer.from(raw), encryptionKey) : transform(Buffer.from(raw))
    return {
        flag: b[4],
        id: b.readUInt16BE(5),
        error: b.readUInt16BE(7),
        seq: b.readUInt32BE(9),
        pushSeq: b.readUInt32BE(13),
        signature: b.readBigUInt64BE(17),
        payload: b[4] & 1 ? (() => {
            const candidate = b.subarray(HEADER_SIZE)
            try { return decompressLz4(candidate) } catch {
                return candidate
            }
        })() : b.subarray(HEADER_SIZE),
    }
}
export class FrameReader {
    constructor({ encryptionKey } = {}) {
        this.buffer = Buffer.alloc(0)
        this.setEncryptionKey(encryptionKey)
    }
    setEncryptionKey(key) {
        this.encryptionKey = key?.length ? Buffer.from(key) : undefined
    }
    feed(chunk, onFrame) {
        this.buffer = Buffer.concat([this.buffer, chunk])
        const frames = []
        while (this.buffer.length >= 4) {
            const size = this.buffer.readUInt32BE(0)
            if (size < HEADER_SIZE || size > MAX_FRAME) throw Error(`Invalid frame length ${size}`)
            if (this.buffer.length < size) break
            const frame = decodeFrame(this.buffer.subarray(0, size), { encryptionKey: this.encryptionKey })
            frames.push(frame)
            this.buffer = this.buffer.subarray(size)
            onFrame?.(frame)
        }
        return frames
    }
}
