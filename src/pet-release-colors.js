import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'

const catalogs = new WeakMap()
function value(tables, title) {
    const rows = tables.get('game').filter((row) => row.title === title)
    ensure(
        rows.length === 1 && typeof rows[0].value === 'string',
        'Color release game setting missing or ambiguous',
        ErrorCode.GameConfig,
    )
    return rows[0].value.trim()
}
function enabled(tables, title) {
    const text = value(tables, title).toLowerCase()
    ensure(['true', 'false', '0', '1'].includes(text), 'Color release switch is malformed', ErrorCode.GameConfig)
    return text === 'true' || text === '1'
}
// Explicit LOCAL reuse of this emulator's relative-weight drop kernel. The
// client proves the flags/preview, not the official server's drop algorithm.
export function petReleaseColorRewards(tables, pet, randomInt, localPolicy) {
    ensure(
        localPolicy?.origin === 'LOCAL' &&
            localPolicy.colorRefunds === 'existing-world-relative-weights-per-current-color-flag',
        'Color release model has not been selected',
        ErrorCode.GameConfig,
    )
    ensure(
        [pet.colorful ?? 0, pet.color ?? 0].every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff),
        'Malformed saved pet color identity',
        ErrorCode.GameConfig,
    )
    let catalog = catalogs.get(tables)
    if (!catalog) catalogs.set(tables, (catalog = new WorldObjectCatalog(tables)))
    const rewards = []
    for (const [active, prefix] of [
        [(pet.colorful ?? 0) > 0, 'STARCOLOR'],
        [(pet.color ?? 0) > 0, 'COLOR'],
    ]) {
        if (!active || !enabled(tables, prefix + '_KIBO_RELEASE_DROP_SWITCH')) continue
        const text = value(tables, prefix + '_KIBO_RELEASE_DROP'),
            id = Number(text)
        ensure(
            /^[1-9]\d*$/.test(text) && Number.isSafeInteger(id) && id <= 0xffffffff,
            'Malformed color release drop identity',
            ErrorCode.GameConfig,
        )
        const rows = tables.get('drop').filter((row) => row.dropId === id)
        ensure(rows.length > 0, 'Color release drop definition is missing', ErrorCode.GameConfig)
        ensure(
            rows.every((row) => [0, 3, 10].includes(row.type)),
            'Color release reward kind is unsupported',
            ErrorCode.FunctionClosed,
        )
        ensure(
            rows.every(
                (row) =>
                    Number.isSafeInteger(row.dropGroupId) &&
                    row.dropGroupId > 0 &&
                    Number.isSafeInteger(row.itemId) &&
                    (row.type === 0 || row.itemId > 0) &&
                    Number.isSafeInteger(row.weight) &&
                    row.weight >= 0 &&
                    Number.isSafeInteger(row.minValue) &&
                    row.minValue >= 0 &&
                    Number.isSafeInteger(row.maxValue) &&
                    row.maxValue >= row.minValue,
            ),
            'Malformed color release drop definition',
            ErrorCode.GameConfig,
        )
        const rng = (bound) => {
            const draw = randomInt(bound)
            ensure(
                Number.isSafeInteger(draw) && draw >= 0 && draw < bound,
                'Invalid color release random sample',
                ErrorCode.GameConfig,
            )
            return draw
        }
        rewards.push(...catalog.drops(id, rng))
    }
    return rewards
}
