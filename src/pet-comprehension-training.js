import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { aggregateCosts } from './inventory.js'

const curves = new WeakMap()
function curve(tables) {
    if (!curves.has(tables)) {
        const enums = new Set(tables.get('pet_learningenum').map((row) => row.attributeEnum)),
            groups = new Map()
        for (const attr of enums) {
            const rows = tables
                .get('pet_talent_upgrade')
                .filter((row) => row.attrId === attr)
                .sort((a, b) => a.level - b.level)
            ensure(
                rows.length &&
                    rows.every(
                        (row, index) =>
                            row.level === index + 1 &&
                            Number.isSafeInteger(row.nextExpVal) &&
                            (index === rows.length - 1 ? row.nextExpVal === 0 : row.nextExpVal > 0) &&
                            Number.isSafeInteger(row.InterA) &&
                            row.InterA >= 0,
                    ),
                'Invalid pet comprehension curve',
                ErrorCode.GameConfig,
            )
            let total = 0
            const starts = rows.map((row) => {
                const value = total
                total += row.nextExpVal
                return value
            })
            ensure(Number.isSafeInteger(total), 'Pet comprehension curve overflow', ErrorCode.GameConfig)
            groups.set(attr, { rows, starts, maximum: total })
        }
        curves.set(tables, { enums, groups })
    }
    return curves.get(tables)
}
export function petComprehensionPlan(tables, pet, items) {
    ensure(
        Array.isArray(items) && items.length > 0,
        'Pet comprehension materials are empty',
        ErrorCode.PetComprehensionItemSizeInvilid,
    )
    const costs = aggregateCosts(items),
        model = curve(tables),
        current = new Map()
    ensure(Array.isArray(pet.comprehension), 'Pet comprehension does not exist', ErrorCode.PetComprehensionNotExist)
    for (const row of pet.comprehension) {
        ensure(
            model.enums.has(row.attr_id) && !current.has(row.attr_id),
            'Invalid or duplicate pet comprehension dimension',
            ErrorCode.GameConfig,
        )
        const group = model.groups.get(row.attr_id),
            exp = row.cur_exp ?? 0
        ensure(
            Number.isInteger(row.level) &&
                row.level >= 1 &&
                row.level <= group.rows.length &&
                Number.isSafeInteger(exp) &&
                exp >= 0 &&
                Number.isSafeInteger(row.value) &&
                row.value >= 0,
            'Invalid saved pet comprehension progress',
            ErrorCode.GameConfig,
        )
        ensure(
            row.level === group.rows.length ? exp === 0 : exp < group.rows[row.level - 1].nextExpVal,
            'Pet comprehension EXP outside current tier',
            ErrorCode.GameConfig,
        )
        current.set(row.attr_id, group.starts[row.level - 1] + exp)
    }
    for (const id of model.enums)
        ensure(current.has(id), 'Pet comprehension dimension does not exist', ErrorCode.PetComprehensionNotExist)
    const original = new Map(current)
    const favorConfig = tables.get('game').find((row) => row.title === 'FRUIT_PET_FAVORABILITY_ONCE')
    ensure(
        typeof favorConfig?.value === 'string' && favorConfig.value.length > 0,
        'Missing fruit favor curve',
        ErrorCode.GameConfig,
    )
    const favorByRarity = favorConfig.value.split('|').map(Number)
    ensure(
        favorByRarity.length && favorByRarity.every((n) => Number.isSafeInteger(n) && n >= 0),
        'Invalid fruit favor curve',
        ErrorCode.GameConfig,
    )
    let favor = 0
    for (const [id, count] of costs) {
        const fruit = tables.find('pet_feed_item', id)
        ensure(fruit?.type === 1, 'Invalid pet comprehension fruit', ErrorCode.PetComprehensionItemInvilid)
        ensure(fruit.isReuse === 0 || fruit.isReuse === 1, 'Invalid pet fruit repeat flag', ErrorCode.GameConfig)
        ensure(fruit.isReuse === 1, 'One-use comprehension fruit not implemented', ErrorCode.FunctionClosed)
        const common = tables.find('common_item', id)
        ensure(
            common && Number.isInteger(common.rarity) && favorByRarity[common.rarity] !== undefined,
            'Pet fruit configuration unavailable',
            ErrorCode.GameConfig,
        )
        const effects = new Map()
        for (const token of String(fruit.param ?? '')
            .split('|')
            .filter(Boolean)) {
            const [attr, gain, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length && model.enums.has(attr) && Number.isSafeInteger(gain) && gain > 0,
                'Invalid comprehension fruit effect',
                ErrorCode.GameConfig,
            )
            const sum = (effects.get(attr) ?? 0) + gain
            ensure(Number.isSafeInteger(sum), 'Fruit effect overflow', ErrorCode.GameConfig)
            effects.set(attr, sum)
        }
        ensure(effects.size > 0, 'Empty comprehension fruit effect', ErrorCode.GameConfig)
        const quota = Math.max(
            ...[...effects].map(([attr, gain]) =>
                Math.ceil((model.groups.get(attr).maximum - current.get(attr)) / gain),
            ),
        )
        ensure(quota > 0 && count <= quota, 'Too many comprehension fruits for remaining capacity')
        for (const [attr, gain] of effects) {
            const next = current.get(attr) + gain * count
            ensure(Number.isSafeInteger(next), 'Comprehension experience overflow', ErrorCode.GameConfig)
            current.set(attr, Math.min(model.groups.get(attr).maximum, next))
        }
        favor += favorByRarity[common.rarity] * count
        ensure(Number.isSafeInteger(favor) && favor <= 0xffffffff, 'Fruit favor overflow', ErrorCode.GameConfig)
    }
    const comprehension = pet.comprehension.map((row) => {
        if (current.get(row.attr_id) === original.get(row.attr_id)) return { ...row }
        const group = model.groups.get(row.attr_id),
            total = current.get(row.attr_id)
        let level = 1
        while (level < group.rows.length && group.starts[level] <= total) level++
        return {
            ...row,
            level,
            value: level === row.level ? row.value : group.rows[level - 1].InterA,
            cur_exp: level === group.rows.length ? 0 : total - group.starts[level - 1],
        }
    })
    return { costs, comprehension, favor }
}
