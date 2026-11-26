import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const copy = (value) => structuredClone(value)

// Current PlayerWardrobeData.Populate/PlayerModPartData.RefreshPartData merge
// facial data. ClothesInfo.PopulateDecorate instead replaces equipped clothes;
// this helper must never be applied to that separate channel.
export function mergeWardrobeInfo(previous = {}, update = {}) {
    const result = { ...copy(previous), ...copy(update), present: update.present ?? 0 }
    for (const field of ['sex', 'height', 'complexion']) {
        ensure(update[field] === undefined || uint(update[field]), 'Invalid wardrobe scalar', ErrorCode.InvalidArgument)
        if (!update[field]) {
            if (previous[field] === undefined) delete result[field]
            else result[field] = previous[field]
        }
    }
    ensure([1, 2].includes(result.sex), 'Invalid wardrobe sex', ErrorCode.InvalidArgument)
    const parts = new Map((previous.parts ?? []).map((part) => [part.type, copy(part)]))
    const incoming = update.parts ?? []
    ensure(
        Array.isArray(incoming) && new Set(incoming.map((part) => part.type)).size === incoming.length,
        'Duplicate wardrobe part',
        ErrorCode.InvalidArgument,
    )
    for (const part of incoming) {
        ensure(
            uint(part.type) && (part.id === undefined || uint(part.id)),
            'Invalid wardrobe part identity',
            ErrorCode.InvalidArgument,
        )
        if (!part.type) continue // Populate ignores an absent/default part type.
        const colors = (part.colors ?? []).map((color) => ({
            ...color,
            index: color.index ?? 0,
            color_id: color.color_id ?? 0,
        }))
        ensure(
            Array.isArray(colors) &&
                colors.every((color) => uint(color.index) && uint(color.color_id)) &&
                new Set(colors.map((color) => color.index)).size === colors.length,
            'Invalid or duplicate wardrobe color channel',
            ErrorCode.InvalidArgument,
        )
        const old = parts.get(part.type) ?? {}
        const next = { ...old, ...copy(part) }
        if (colors.length) next.colors = copy(colors)
        if (!part.id && old.id !== undefined) next.id = old.id
        if (!colors.length) next.colors = copy(old.colors ?? [])
        if (part.color_formular_ids === undefined && old.color_formular_ids !== undefined)
            next.color_formular_ids = copy(old.color_formular_ids)
        parts.set(part.type, next)
    }
    result.parts = [...parts.values()]
    const avatars = new Map((previous.avatars ?? []).map((avatar) => [avatar.avatar_type, copy(avatar)]))
    ensure(Array.isArray(update.avatars ?? []), 'Invalid wardrobe avatar collection', ErrorCode.InvalidArgument)
    for (const avatar of update.avatars ?? []) {
        ensure(
            (avatar.avatar_type === undefined || typeof avatar.avatar_type === 'string') &&
                (avatar.avatar_url === undefined || typeof avatar.avatar_url === 'string'),
            'Invalid wardrobe avatar',
            ErrorCode.InvalidArgument,
        )
        if (avatar.avatar_type)
            avatars.set(avatar.avatar_type, { ...copy(avatar), avatar_url: avatar.avatar_url ?? '' })
    }
    result.avatars = [...avatars.values()]
    return result
}
