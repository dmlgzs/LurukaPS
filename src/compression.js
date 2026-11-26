// Current1.0 CompressUtility.DecompressLZ4 06031779 consumes a raw LZ4 block.
export function decompressLz4(input, maxOutput = 4 * 1024 * 1024) {
    const out = Buffer.alloc(maxOutput)
    let ip = 0,
        op = 0
    const read = () => {
        if (ip >= input.length) throw Error('Truncated LZ4 block')
        return input[ip++]
    }
    const length = (n) => {
        if (n === 15) {
            let b
            do {
                b = read()
                n += b
                if (n > maxOutput) throw Error('LZ4 size limit')
            } while (b === 255)
        }
        return n
    }
    while (ip < input.length) {
        const token = read()
        const literals = length(token >>> 4)
        if (ip + literals > input.length || op + literals > maxOutput) throw Error('Invalid LZ4 literals')
        input.copy(out, op, ip, ip + literals)
        ip += literals
        op += literals
        if (ip === input.length) break
        const offset = read() | (read() << 8)
        if (offset === 0 || offset > op) throw Error('Invalid LZ4 offset')
        const match = length(token & 15) + 4
        if (op + match > maxOutput) throw Error('LZ4 output limit')
        for (let i = 0; i < match; i++) out[op + i] = out[op - offset + i]
        op += match
    }
    return out.subarray(0, op)
}

// Raw LZ4 block: token/literals/LE16 offset/match length, without a frame or
// original-size prefix. The caller chooses whether compression is worthwhile.
export function compressLz4(input, maxOutput = 4 * 1024 * 1024) {
    if (!(input instanceof Uint8Array)) throw TypeError('LZ4 input must be bytes')
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw RangeError('Invalid LZ4 output limit')
    const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength),
        size = source.length
    // LZ4's specified maximum input, also keeping hash positions in Int32.
    if (size > 0x7e000000) throw RangeError('LZ4 input size limit')
    const bound = size + Math.floor(size / 255) + 16,
        out = Buffer.allocUnsafe(Math.min(bound, maxOutput)),
        positions = new Int32Array(1 << 16).fill(-1),
        matchLimit = size - 12,
        matchEndLimit = size - 5,
        hash = (position) => Math.imul(source.readUInt32LE(position), 0x9e3779b1) >>> 16,
        extensionBytes = (length) => (length < 15 ? 0 : Math.floor((length - 15) / 255) + 1)
    let cursor = 0,
        anchor = 0,
        op = 0
    const reserve = (count) => {
        if (op + count > out.length) throw RangeError('LZ4 output limit')
    }
    const extension = (length) => {
        if (length < 15) return
        let extra = length - 15
        while (extra >= 255) {
            out[op++] = 255
            extra -= 255
        }
        out[op++] = extra
    }
    while (cursor <= matchLimit) {
        const key = hash(cursor),
            previous = positions[key]
        positions[key] = cursor
        if (
            previous < 0 ||
            cursor - previous > 0xffff ||
            source.readUInt32LE(previous) !== source.readUInt32LE(cursor)
        ) {
            cursor++
            continue
        }
        let end = cursor + 4
        while (end < matchEndLimit && source[end] === source[previous + end - cursor]) end++
        const literals = cursor - anchor,
            match = end - cursor - 4,
            offset = cursor - previous
        reserve(1 + extensionBytes(literals) + literals + 2 + extensionBytes(match))
        out[op++] = (Math.min(literals, 15) << 4) | Math.min(match, 15)
        extension(literals)
        source.copy(out, op, anchor, cursor)
        op += literals
        out.writeUInt16LE(offset, op)
        op += 2
        extension(match)
        // Every source position is hashed at most once, including skipped
        // matches. This retains near matches without a quadratic search chain.
        for (let position = cursor + 1; position < end && position <= matchLimit; position++)
            positions[hash(position)] = position
        cursor = end
        anchor = end
    }
    const literals = size - anchor
    reserve(1 + extensionBytes(literals) + literals)
    out[op++] = Math.min(literals, 15) << 4
    extension(literals)
    source.copy(out, op, anchor)
    op += literals
    // Do not retain a large scratch allocation for a small compressed packet.
    return Buffer.from(out.subarray(0, op))
}
