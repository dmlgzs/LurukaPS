import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

function varint(bytes, offset) {
    let value = 0n
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
        const octet = bytes[offset++]
        value |= BigInt(octet & 127) << BigInt(count * 7)
        if (!(octet & 128)) {
            ensure(value <= 0xffffffffffffffffn, 'Arena preset varint overflow', ErrorCode.GameConfig)
            return { value, offset }
        }
    }
    ensure(false, 'Truncated arena preset varint', ErrorCode.GameConfig)
}
function encode(value) {
    const bytes = []
    do {
        const octet = Number(value & 127n)
        value >>= 7n
        bytes.push(octet | (value ? 128 : 0))
    } while (value)
    return Buffer.from(bytes)
}
function fields(bytes, start = 0, end = bytes.length, group = 0) {
    const rows = []
    let offset = start
    while (offset < end) {
        const begin = offset,
            tag = varint(bytes, offset)
        offset = tag.offset
        const number = Number(tag.value >> 3n),
            wire = Number(tag.value & 7n),
            row = { begin, number, wire, tagEnd: offset }
        ensure(number > 0 && number <= 0x1fffffff, 'Invalid arena preset field', ErrorCode.GameConfig)
        if (wire === 4) {
            ensure(group === number, 'Invalid arena preset group', ErrorCode.GameConfig)
            return { rows, offset }
        }
        if (wire === 0) {
            const item = varint(bytes, offset)
            row.value = item.value
            offset = item.offset
        } else if (wire === 1) offset += 8
        else if (wire === 5) offset += 4
        else if (wire === 2) {
            const size = varint(bytes, offset)
            ensure(size.value <= BigInt(end - size.offset), 'Truncated arena preset bytes', ErrorCode.GameConfig)
            row.bodyStart = size.offset
            row.bodyEnd = offset = size.offset + Number(size.value)
        } else if (wire === 3) offset = fields(bytes, offset, end, number).offset
        else ensure(false, 'Invalid arena preset wire type', ErrorCode.GameConfig)
        ensure(offset <= end, 'Truncated arena preset field', ErrorCode.GameConfig)
        rows.push({ ...row, end: offset })
    }
    ensure(!group, 'Unterminated arena preset group', ErrorCode.GameConfig)
    return { rows, offset }
}
// Current and historical PetDuelGroupInfo: tag2=TrialPet; its guid1,
// is_trial2 and id3 are unchanged. Patch only owned scalar varints. Every
// other byte (including unknown fields, order and duplicates) survives.
export function migratePetPresetWire(protocol, text, mapping) {
    ensure(
        typeof text === 'string' && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text),
        'Invalid encoded arena preset',
        ErrorCode.GameConfig,
    )
    ensure(protocol, 'Pet preset migration requires the current protocol', ErrorCode.GameConfig)
    const type = protocol.type('cs.PetDuelGroupInfo').resolveAll(),
        trial = type.fieldsById[2]?.resolvedType
    ensure(
        type.fieldsById[2]?.name === 'pet_guids' &&
            trial?.fieldsById[1]?.name === 'guid' &&
            trial?.fieldsById[2]?.name === 'is_trial' &&
            trial?.fieldsById[3]?.name === 'id',
        'Arena preset schema changed',
        ErrorCode.GameConfig,
    )
    const bytes = Buffer.from(text, 'base64')
    ensure(bytes.toString('base64') === text, 'Noncanonical arena preset encoding', ErrorCode.GameConfig)
    let changed = false
    const chunks = fields(bytes).rows.map((row) => {
        if (row.number !== 2) return bytes.subarray(row.begin, row.end)
        ensure(row.wire === 2, 'Invalid arena preset pet field', ErrorCode.GameConfig)
        const pets = fields(bytes, row.bodyStart, row.bodyEnd).rows
        const flag = pets.filter((pet) => pet.number === 2).at(-1)
        ensure(!flag || flag.wire === 0, 'Invalid arena preset trial flag', ErrorCode.GameConfig)
        if (flag?.value) return bytes.subarray(row.begin, row.end)
        let patched = false
        const body = Buffer.concat(
            pets.map((pet) => {
                if (![1, 3].includes(pet.number)) return bytes.subarray(pet.begin, pet.end)
                ensure(pet.wire === 0, 'Invalid arena preset identity field', ErrorCode.GameConfig)
                const target = mapping[pet.value.toString()]
                if (target === undefined) return bytes.subarray(pet.begin, pet.end)
                patched = changed = true
                return Buffer.concat([bytes.subarray(pet.begin, pet.tagEnd), encode(BigInt(target))])
            }),
        )
        return patched
            ? Buffer.concat([bytes.subarray(row.begin, row.tagEnd), encode(BigInt(body.length)), body])
            : bytes.subarray(row.begin, row.end)
    })
    return changed ? Buffer.concat(chunks).toString('base64') : text
}
