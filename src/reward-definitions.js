import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { appearanceCatalog } from './appearance.js'
import { customOrnamentConfiguration } from './ornaments.js'
import { eggRewardDefinition } from './eggs.js'
import { customizedPetRewardDefinition } from './pets.js'
const uint = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const recipe = (fn) => {
    try {
        return fn()
    } catch (error) {
        ensure(false, `Deferred reward recipe is unavailable: ${error.message}`, ErrorCode.GameConfig)
    }
}
const definitions = new Map([
    [3, 'common_item'],
    [5, 'pet'],
    [9, 'soulessence'],
    [13, 'home_building'],
    [17, 'player_title'],
    [20, 'task_item'],
    [25, 'mount_saddle'],
    [26, 'playercard_dress'],
    [28, 'library_readings'],
    [37, 'pet_skin'],
    [40, 'home_dorm_item'],
])
// Whole-list bounds are independent of the current player's occupancy. Every
// attachment of an atomic6121 claim must fit even in an empty destination.
export function validateRewardTotals(tables, rewards) {
    ensure(Array.isArray(rewards) && rewards.length > 0, 'Invalid deferred reward totals', ErrorCode.GameConfig)
    const totals = new Map()
    const add = (key, count, maximum, label) => {
        const total = (totals.get(key) ?? 0n) + BigInt(count)
        ensure(total <= maximum, `Deferred ${label} total exceeds its static capacity`, ErrorCode.GameConfig)
        totals.set(key, total)
    }
    const constant = (name) => {
        const value = Number(tables.get('game').find((row) => row.title === name)?.value)
        ensure(uint(value), 'Deferred reward capacity configuration is malformed', ErrorCode.GameConfig)
        return BigInt(value)
    }
    for (const { itemtype, itemid, itemnum } of rewards) {
        ensure([itemtype, itemid, itemnum].every(uint), 'Malformed deferred reward total', ErrorCode.GameConfig)
        if (itemtype === 14) add('eggs', itemnum, constant('PET_EGG_LIMITS'), 'egg')
        else if (itemtype === 5 || itemtype === 30)
            add('pets', itemnum, constant('PET_BOX_NUM') * constant('PET_BOX_LIMIT'), 'pet')
        else if (itemtype === 9) add('equipment', itemnum, 10000n, 'equipment')
        else if (itemtype === 33) add('ornaments', itemnum, 10000n, 'ornament')
        else if (itemtype === 3 || itemtype === 13) add(`${itemtype}:${itemid}`, itemnum, 0xffffffffn, 'item/building')
        else if (itemtype === 20) add(`task:${itemid}`, itemnum, 99n, 'task item')
        else if (itemtype === 10) {
            const area = tables.get('kibo_duel_area_type').find((row) => row.currencyId === itemid)
            const maximum = [1, 2, 10].includes(itemid) ? 0x7fffffffn : area ? 0xffffffffn : 0xffffffffffffffffn
            add(`currency:${itemid}`, itemnum, maximum, 'currency')
        } else if (itemtype === 29) {
            const groups = new Set(tables.get('reputation_level').map((row) => row.reputationId))
            const group = [...groups].find((id) => id === itemid || tables.find('groups', id)?.reputation === itemid)
            ensure(group, 'Deferred reputation total has no group', ErrorCode.GameConfig)
            add(`reputation:${group}`, itemnum, 0xffffffffn, 'reputation')
        } else if ([1, 17, 25, 26, 28, 34, 37, 39, 40].includes(itemtype))
            add(`unique:${itemtype}:${itemid}`, itemnum, 1n, 'unique reward')
        else ensure(false, 'Unsupported deferred reward total type', ErrorCode.GameConfig)
    }
    return rewards
}
// Pure definition checks for deferred mail rewards. No account, inventory,
// random roll, identity allocation or actual grant is involved. GrantRewards
// remains the only delivery path when6121 claims the attachment.
export function validateRewardDefinitions(tables, rewards, { channel = 'mail' } = {}) {
    ensure(
        channel === 'mail' && Array.isArray(rewards) && rewards.length > 0,
        'Invalid deferred reward definitions',
        ErrorCode.GameConfig,
    )
    for (const reward of rewards) {
        const { itemtype, itemid, itemnum } = reward
        ensure(
            [itemtype, itemid, itemnum].every(uint),
            'Malformed deferred reward quantity or identity',
            ErrorCode.GameConfig,
        )
        if ([1, 17, 25, 26, 28, 34, 37, 39, 40].includes(itemtype))
            ensure(itemnum === 1, 'Unique deferred reward must have quantity one', ErrorCode.GameConfig)
        if (itemtype === 5 || itemtype === 30) {
            const boxes = Number(tables.get('game').find((r) => r.title === 'PET_BOX_NUM')?.value),
                slots = Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT')?.value)
            ensure(
                uint(boxes) && uint(slots) && slots < 100 && itemnum <= boxes * slots,
                'Deferred pet quantity exceeds the static capacity',
                ErrorCode.GameConfig,
            )
        }
        if (itemtype === 14) {
            const maximum = Number(tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS')?.value)
            ensure(
                uint(maximum) && itemnum <= maximum,
                'Deferred egg quantity exceeds the static capacity',
                ErrorCode.GameConfig,
            )
        }
        if (itemtype === 1) {
            ensure(
                tables.find('hero', itemid)?.isUsable === 1,
                'Deferred hero definition is unavailable',
                ErrorCode.GameConfig,
            )
        } else if (itemtype === 10) {
            ensure(tables.find('currency', itemid), 'Deferred currency definition is unavailable', ErrorCode.GameConfig)
            // No entry roster, selected pets or battle-pass recipient exists in
            // a generic mail. Do not create a legacy global favor/XP balance.
            ensure(
                ![4, 14, 50].includes(itemid),
                'Deferred currency requires an explicit recipient context',
                ErrorCode.GameConfig,
            )
            if ([1, 2, 10].includes(itemid))
                ensure(
                    itemnum <= 0x7fffffff,
                    'Deferred currency exceeds its static quantity bound',
                    ErrorCode.GameConfig,
                )
        } else if (itemtype === 29) {
            const rows = tables.get('reputation_level'),
                groups = new Set(rows.map((r) => r.reputationId))
            const group = [...groups].find((id) => id === itemid || tables.find('groups', id)?.reputation === itemid)
            ensure(
                group && tables.find('currency', tables.find('groups', group)?.reputation),
                'Deferred reputation definition is unavailable',
                ErrorCode.GameConfig,
            )
        } else if (itemtype === 33) {
            recipe(() => customOrnamentConfiguration(tables, itemid))
            ensure(itemnum <= 1000, 'Deferred ornament quantity exceeds the constructor bound', ErrorCode.GameConfig)
        } else if (itemtype === 14) {
            recipe(() => eggRewardDefinition(tables, itemid))
        } else if (itemtype === 30) {
            recipe(() => customizedPetRewardDefinition(tables, itemid))
        } else if (itemtype === 34 || itemtype === 39) {
            const catalog = appearanceCatalog(tables)
            ensure(
                (itemtype === 34 ? catalog.clothes : catalog.skins).has(itemid),
                'Deferred appearance definition is unavailable',
                ErrorCode.GameConfig,
            )
        } else {
            const name = definitions.get(itemtype),
                row = name && tables.find(name, itemid)
            ensure(row, 'Unsupported or unavailable deferred reward definition', ErrorCode.GameConfig)
            if (itemtype === 5)
                ensure(
                    tables.find('template_value', itemid) && tables.find('pet_builder_rule', 1001),
                    'Deferred pet base definition is unavailable',
                    ErrorCode.GameConfig,
                )
            if (itemtype === 9)
                ensure(
                    itemnum <= 1000,
                    'Deferred equipment quantity exceeds the constructor bound',
                    ErrorCode.GameConfig,
                )
            if (itemtype === 17)
                ensure([1, 2].includes(row.type), 'Deferred title type is malformed', ErrorCode.GameConfig)
            if (itemtype === 20)
                ensure(itemnum <= 99, 'Deferred task item exceeds the static quantity limit', ErrorCode.GameConfig)
            if (itemtype === 37)
                ensure(
                    [0, 1].includes(row.isNormal) && tables.find('pet', row.kiboId),
                    'Deferred pet skin definition is malformed',
                    ErrorCode.GameConfig,
                )
        }
    }
    return validateRewardTotals(tables, rewards)
}
