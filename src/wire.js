import { strongTransform } from './wire-crypto.js'
import { GateGcmCipher, GATE_GCM_FLAG, GATE_GCM_OVERHEAD } from './wire-gcm.js'
import { compressLz4, decompressLz4 } from './compression.js'
import key from '../configs/wire-key.json' with { type: 'json' }
export const HEADER_SIZE = 25
export const MAX_FRAME = 4 * 1024 * 1024
// Current TcpSocket.ReceiveHeader06004d01 rejects larger inbound wire frames.
// MAX_FRAME remains this server's separate local receive/raw-work budget.
export const PEER_MAX_FRAME = 1024 * 1024
function transform(buffer) {
    const offset = Math.floor(buffer.length / 3)
    for (let i = 7; i < buffer.length; i++) buffer[i] ^= key[(offset + i - 7) % key.length]
    return buffer
}
export function encodeFrame(
    { id, seq = 0, pushSeq = 0, error = 0, flag = 0, signature = 0n },
    payload = Buffer.alloc(0),
    { encryptionKey, gcmCipher } = {},
) {
    if (HEADER_SIZE + payload.length > MAX_FRAME) throw Error('Frame exceeds raw size limit')
    validateFlags(flag)
    if (flag & GATE_GCM_FLAG && !gcmCipher) throw Error('Gate GCM key is not installed')
    if (!(flag & 1) && payload.length >= 1024) {
        let compressed
        try {
            compressed = compressLz4(payload, MAX_FRAME)
        } catch (error) {
            // Incompressible data near the local work budget can exceed the
            // compressor's bounded scratch output. Never truncate that body.
            if (!(error instanceof RangeError) || error.message !== 'LZ4 output limit') throw error
        }
        if (compressed?.length > 0 && compressed.length < payload.length) {
            payload = compressed
            flag |= 1
        }
    }
    const size = HEADER_SIZE + payload.length
    if (size + (gcmCipher ? GATE_GCM_OVERHEAD : 0) > PEER_MAX_FRAME) throw Error('Frame exceeds peer size limit')
    const b = Buffer.alloc(size)
    b.writeUInt32BE(size)
    b.writeUInt8(flag, 4)
    b.writeUInt16BE(id, 5)
    b.writeUInt16BE(error, 7)
    b.writeUInt32BE(seq, 9)
    b.writeUInt32BE(pushSeq, 13)
    b.writeBigUInt64BE(BigInt(signature), 17)
    payload.copy(b, HEADER_SIZE)
    if (gcmCipher) return gcmCipher.seal(b)
    return flag & 2 ? strongTransform(b, encryptionKey) : transform(b)
}
function validateFlags(flag) {
    // Current MessageFlag contains compressed1, legacy RC4 2 and Gate GCM4.
    if (flag & ~7) throw Error('Unsupported frame flags')
    if ((flag & 6) === 6) throw Error('Mixed RC4 and Gate GCM flags')
}
export function decodeFrame(raw, { encryptionKey, gcmCipher } = {}) {
    if (raw.length < HEADER_SIZE || raw.length > MAX_FRAME || raw.readUInt32BE(0) !== raw.length)
        throw Error('Invalid frame size')
    validateFlags(raw[4])
    const gcm = !!(raw[4] & GATE_GCM_FLAG)
    if (gcm && !gcmCipher) throw Error('Gate GCM key is not installed')
    if (raw[4] & 2 && gcmCipher) throw Error('Legacy RC4 is not allowed after Gate GCM installation')
    const b = gcm ? raw : raw[4] & 2 ? strongTransform(Buffer.from(raw), encryptionKey) : transform(Buffer.from(raw))
    const payload = gcm ? gcmCipher.open(raw) : b.subarray(HEADER_SIZE)
    return {
        flag: b[4],
        id: b.readUInt16BE(5),
        error: b.readUInt16BE(7),
        seq: b.readUInt32BE(9),
        pushSeq: b.readUInt32BE(13),
        signature: b.readBigUInt64BE(17),
        payload: b[4] & 1 ? decompressLz4(payload) : payload,
    }
}
export class FrameReader {
    constructor({ encryptionKey, gcmCipher } = {}) {
        this.buffer = Buffer.alloc(0)
        this.setEncryptionKey(encryptionKey)
        if (gcmCipher) this.setGcmCipher(gcmCipher)
    }
    setEncryptionKey(key) {
        if (this.gcmCipher) throw Error('Gate encryption key cannot change on this connection')
        this.encryptionKey = key?.length ? Buffer.from(key) : undefined
    }
    setGcmCipher(cipher) {
        if (!(cipher instanceof GateGcmCipher)) throw Error('Invalid Gate GCM cipher')
        if (this.gcmCipher && this.gcmCipher !== cipher)
            throw Error('Gate encryption key cannot change on this connection')
        this.encryptionKey = undefined
        this.gcmCipher = cipher
    }
    feed(chunk, onFrame) {
        this.buffer = Buffer.concat([this.buffer, chunk])
        const frames = []
        while (this.buffer.length >= 4) {
            const size = this.buffer.readUInt32BE(0)
            if (size < HEADER_SIZE || size > MAX_FRAME) throw Error(`Invalid frame length ${size}`)
            if (this.buffer.length < size) break
            const frame = decodeFrame(this.buffer.subarray(0, size), {
                encryptionKey: this.encryptionKey,
                gcmCipher: this.gcmCipher,
            })
            frames.push(frame)
            this.buffer = this.buffer.subarray(size)
            onFrame?.(frame)
        }
        return frames
    }
}
