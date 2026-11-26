import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'

export const GATE_GCM_FLAG = 4
export const GATE_GCM_OVERHEAD = 24
export const GATE_GCM_CLIENT_MAX_PLAIN_FRAME = 262120
export const GATE_GCM_USAGE_LIMIT = 0x100000000n
const HEADER_SIZE = 25
const AAD_SIZE = 33
const TAG_SIZE = 16

export function gateGcmUsageAfterSeal(sequence, blocks, payloadLength) {
    if (
        typeof sequence !== 'bigint' ||
        typeof blocks !== 'bigint' ||
        sequence < 0n ||
        blocks < 0n ||
        !Number.isSafeInteger(payloadLength) ||
        payloadLength < 0 ||
        payloadLength > 0xffffffff - HEADER_SIZE - GATE_GCM_OVERHEAD
    )
        throw Error('Invalid Gate GCM send usage')
    const cost = 4n + BigInt(Math.ceil(payloadLength / 16))
    if (sequence >= GATE_GCM_USAGE_LIMIT || blocks + cost > GATE_GCM_USAGE_LIMIT)
        throw Error('Gate GCM send usage exhausted')
    return { sequence: sequence + 1n, blocks: blocks + cost }
}

export class GateGcmCipher {
    #material
    #sendKey
    #sendPrefix
    #receiveKey
    #receivePrefix
    #usage = { sequence: 0n, blocks: 0n }
    #disposed = false
    #maxSendLength

    constructor(material, { role = 'server', maxSendLength } = {}) {
        if (!(material instanceof Uint8Array) || material.length !== 40)
            throw Error('Invalid Gate GCM key material length')
        if (role !== 'server' && role !== 'client') throw Error('Invalid Gate GCM role')
        // The current client Seal cap is observed IL. The server default is a local transport budget,
        // not a claim about an official server or the client's declared MaxReceiveLength.
        this.#maxSendLength =
            maxSendLength ?? (role === 'client' ? GATE_GCM_CLIENT_MAX_PLAIN_FRAME : 4 * 1024 * 1024 - GATE_GCM_OVERHEAD)
        if (
            !Number.isSafeInteger(this.#maxSendLength) ||
            this.#maxSendLength < HEADER_SIZE ||
            this.#maxSendLength > 0xffffffff - GATE_GCM_OVERHEAD ||
            (role === 'client' && this.#maxSendLength > GATE_GCM_CLIENT_MAX_PLAIN_FRAME)
        )
            throw Error('Invalid Gate GCM send length limit')
        this.#material = Buffer.from(material)
        const send = role === 'server' ? 20 : 0
        const receive = role === 'server' ? 0 : 20
        this.#sendKey = this.#material.subarray(send, send + 16)
        this.#sendPrefix = this.#material.subarray(send + 16, send + 20)
        this.#receiveKey = this.#material.subarray(receive, receive + 16)
        this.#receivePrefix = this.#material.subarray(receive + 16, receive + 20)
    }

    get usage() {
        return { ...this.#usage }
    }

    matchesKey(material) {
        return (
            !this.#disposed &&
            material instanceof Uint8Array &&
            material.length === 40 &&
            timingSafeEqual(this.#material, material)
        )
    }

    #checkAlive() {
        if (this.#disposed) throw Error('Gate GCM cipher is disposed')
    }

    seal(clearFrame) {
        this.#checkAlive()
        if (!Buffer.isBuffer(clearFrame) || clearFrame.length < HEADER_SIZE || clearFrame.length > this.#maxSendLength)
            throw Error('Gate GCM send length out of range')
        const nextUsage = gateGcmUsageAfterSeal(
            this.#usage.sequence,
            this.#usage.blocks,
            clearFrame.length - HEADER_SIZE,
        )
        const output = Buffer.alloc(clearFrame.length + GATE_GCM_OVERHEAD)
        clearFrame.copy(output, 0, 0, HEADER_SIZE)
        output.writeUInt32BE(output.length)
        output[4] = (clearFrame[4] & 1) | GATE_GCM_FLAG
        output.writeBigUInt64BE(this.#usage.sequence, HEADER_SIZE)
        const nonce = Buffer.concat([this.#sendPrefix, output.subarray(HEADER_SIZE, AAD_SIZE)])
        // The current client consumes usage before Crypt; crypto failure does not reuse this nonce.
        this.#usage = nextUsage
        try {
            const cipher = createCipheriv('aes-128-gcm', this.#sendKey, nonce, { authTagLength: TAG_SIZE })
            cipher.setAAD(output.subarray(0, AAD_SIZE))
            const ciphertext = Buffer.concat([cipher.update(clearFrame.subarray(HEADER_SIZE)), cipher.final()])
            ciphertext.copy(output, AAD_SIZE)
            cipher.getAuthTag().copy(output, output.length - TAG_SIZE)
            return output
        } catch (error) {
            output.fill(0)
            throw error
        } finally {
            nonce.fill(0)
        }
    }

    // Returns only authenticated payload. Header parsing, flags, framing and decompression belong to wire.js.
    // Like current GateGcmCipher.Open, this deliberately accepts authenticated duplicates/out-of-order sequences.
    open(wireFrame) {
        this.#checkAlive()
        if (!Buffer.isBuffer(wireFrame) || wireFrame.length < HEADER_SIZE + GATE_GCM_OVERHEAD)
            throw Error('Invalid Gate GCM frame')
        const nonce = Buffer.concat([this.#receivePrefix, wireFrame.subarray(HEADER_SIZE, AAD_SIZE)])
        let pending
        try {
            const decipher = createDecipheriv('aes-128-gcm', this.#receiveKey, nonce, { authTagLength: TAG_SIZE })
            decipher.setAAD(wireFrame.subarray(0, AAD_SIZE))
            decipher.setAuthTag(wireFrame.subarray(-TAG_SIZE))
            pending = decipher.update(wireFrame.subarray(AAD_SIZE, -TAG_SIZE))
            const final = decipher.final()
            return Buffer.concat([pending, final])
        } finally {
            pending?.fill(0)
            nonce.fill(0)
        }
    }

    dispose() {
        this.#material.fill(0)
        this.#disposed = true
    }
}
