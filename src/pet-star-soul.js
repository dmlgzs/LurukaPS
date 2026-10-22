import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const caches = new WeakMap()
function catalog(tables) {
    if (caches.has(tables)) return caches.get(tables)
    const groups = new Map()
    for (const row of tables.get('pet_starsoul')) {
        ensure(
            [row.templateId, row.group, row.node].every((n) => Number.isInteger(n) && n > 0),
            'Invalid star-soul row key',
            ErrorCode.PetSoulLinkConfig,
        )
        if (!groups.has(row.templateId)) groups.set(row.templateId, [])
        groups.get(row.templateId).push(row)
    }
    for (const rows of groups.values()) {
        rows.sort((a, b) => a.group - b.group || a.node - b.node)
        ensure(rows[0].group === 1 && rows[0].node === 1, 'Star-soul opening unavailable', ErrorCode.PetSoulLinkConfig)
        rows.forEach((r, i) => {
            const prev = rows[i - 1]
            ensure(
                [1, 2, 3].includes(r.type) &&
                    Number.isInteger(r.skillSumParam) &&
                    r.skillSumParam >= 0 &&
                    (!prev ||
                        (r.group === prev.group && r.node === prev.node + 1) ||
                        (r.group === prev.group + 1 && r.node === 1)),
                'Invalid star-soul progression',
                ErrorCode.PetSoulLinkConfig,
            )
            ensure(
                (r.type === 3) === (i === rows.length - 1),
                'Invalid star-soul terminal',
                ErrorCode.PetSoulLinkConfig,
            )
        })
    }
    caches.set(tables, groups)
    return groups
}
export function petSoulRow(tables, pet) {
    const config = tables.find('pet', pet.config_id)
    ensure(config, 'Pet configuration unavailable', ErrorCode.PetConfNotExist)
    // Untrained saves omit this uint64; the current client defaults to 1/1.
    const raw = String(pet.soul_link_level ?? '0')
    ensure(
        /^\d+$/.test(raw) && BigInt(raw) <= 0xffffffffffffffffn,
        'Invalid saved star-soul position',
        ErrorCode.GameConfig,
    )
    const n = BigInt(raw),
        stage = n === 0n ? 1 : Number(n >> 32n),
        node = n === 0n ? 1 : Number(n & 0xffffffffn)
    const rows = catalog(tables).get(config.starsoulId)
    ensure(rows, 'Star-soul template unavailable', ErrorCode.PetSoulLinkConfig)
    const index = rows.findIndex((r) => r.group === stage && r.node === node)
    ensure(index >= 0, 'Saved star-soul node unavailable', ErrorCode.GameConfig)
    return { config, rows, index, row: rows[index] }
}
export function petSoulAttributes(tables, pet) {
    if (!pet.soul_link_level || pet.soul_link_level === '0') return new Map()
    const { row } = petSoulRow(tables, pet),
        result = new Map()
    for (const token of String(row.attrSumParam ?? '')
        .split('|')
        .filter(Boolean)) {
        const a = token.split('#').map(Number)
        ensure(
            a.length === 2 &&
                Number.isInteger(a[0]) &&
                a[0] > 0 &&
                Number.isSafeInteger(a[1]) &&
                tables.get('battle_info').some((r) => r.attrVal === a[0]),
            'Invalid cumulative star-soul attributes',
            ErrorCode.PetSoulLinkConfig,
        )
        ensure(!result.has(a[0]), 'Duplicate star-soul attribute', ErrorCode.PetSoulLinkConfig)
        result.set(a[0], a[1])
    }
    return result
}
function constant(tables, name) {
    const r = tables.get('game').find((r) => r.title === name)
    ensure(r, 'Pet skill slot constant unavailable', ErrorCode.GameConfig)
    return String(r.value).split('|').map(Number)
}
function upgradedSkills(tables, pet, config, next) {
    const signature = constant(tables, 'PET_SIGNATURESKILLLIST')[0],
        range = constant(tables, 'PET_SKILLLIST'),
        burst = constant(tables, 'PET_BREAKSKILLLIST')[0]
    ensure(
        range.length === 2 && [signature, burst, ...range].every((x) => Number.isInteger(x) && x > 0),
        'Invalid pet skill slot range',
        ErrorCode.GameConfig,
    )
    const fixed = new Set(
        String(config.fixedSkillList ?? '')
            .split('|')
            .filter(Boolean)
            .map((s) => Number(s.split('#')[0])),
    )
    const target = Math.max(1, next.skillSumParam)
    ensure(Array.isArray(pet.inherent_skills), 'Saved pet skills unavailable', ErrorCode.GameConfig)
    return pet.inherent_skills.map((skill) => {
        const chosen =
            skill.skill_slot === signature ||
            skill.skill_slot === burst ||
            (skill.skill_slot >= range[0] && skill.skill_slot <= range[1] && !fixed.has(skill.skill_slot))
        if (!chosen) return { ...skill }
        ensure(
            tables.get('skill_level').some((r) => r.skillId === skill.skill_id && r.level === target),
            'Star-soul skill level unavailable',
            ErrorCode.PetSoulLinkConfig,
        )
        return { ...skill, skill_lv: target }
    })
}
export function planPetSoulUpgrade(tables, state, pet) {
    const { config, rows, index, row } = petSoulRow(tables, pet)
    ensure(row.type !== 3, 'Star-soul maximum reached', ErrorCode.PetSoulMaxLevel)
    const next = rows[index + 1]
    ensure(next, 'Next star-soul node unavailable', ErrorCode.PetSoulLinkConfig)
    const cond = String(row.unlockCondition ?? '')
        .split('|')
        .map(Number)
    ensure(
        cond.length === 2 && cond[0] === 2004 && Number.isInteger(cond[1]) && cond[1] > 0,
        'Unsupported star-soul condition',
        ErrorCode.PetSoulLinkConfig,
    )
    ensure(
        state.player.basic_info.lv >= cond[1],
        'Star-soul level requirement not met',
        ErrorCode.PetSoulLevelCondition,
    )
    const suppression = pet.suppress_lv ?? 0,
        force = BigInt(state.player.attr_infos.attrs.find((r) => r.attr_id === 22)?.attr_val ?? '0')
    ensure(Number.isInteger(suppression) && suppression >= 0, 'Invalid pet suppression', ErrorCode.GameConfig)
    if (BigInt(suppression) > force) {
        const decay = tables.get('pet_level_decay').find((r) => r.lvDif === Number(BigInt(suppression) - force))
        const amount =
            decay?.[
                pet.original_type === 1
                    ? 'bossAttriDown'
                    : pet.original_type === 2
                      ? 'eliteAttriDown'
                      : 'normalAttriDown'
            ] ?? 0
        ensure(amount === 0, 'Suppressed pet cannot upgrade star-soul', ErrorCode.PetSoulLevelCondition)
    }
    const costs = [],
        add = (type, id, num) => {
            ensure(
                [3, 10].includes(type) && Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(num) && num > 0,
                'Invalid star-soul cost',
                ErrorCode.PetSoulLinkReward,
            )
            ensure(
                type !== 3 || tables.find('common_item', id),
                'Star-soul material unavailable',
                ErrorCode.PetSoulLinkReward,
            )
            costs.push({ type, id, num })
        }
    for (const token of String(row.item ?? '')
        .split('|')
        .filter(Boolean)) {
        const a = token.split('#').map(Number)
        ensure(a.length === 3, 'Invalid star-soul cost tuple', ErrorCode.PetSoulLinkReward)
        add(...a)
    }
    ensure(
        Number.isSafeInteger(row.kiboItemNum) && row.kiboItemNum >= 0,
        'Invalid pet soul material quantity',
        ErrorCode.PetSoulLinkReward,
    )
    if (row.kiboItemNum) add(3, config.starsoulItem, row.kiboItemNum)
    ensure(costs.length, 'Nonterminal star-soul cost unavailable', ErrorCode.PetSoulLinkReward)
    const value = ((BigInt(next.group) << 32n) | BigInt(next.node)).toString()
    // Validate the attributes before consuming anything; current-row cumulative
    // totals are UI display values and battle.js converts the wire units.
    petSoulAttributes(tables, { ...pet, soul_link_level: value })
    return { value, costs, skills: upgradedSkills(tables, pet, config, next) }
}

// Shared with the separately delivered DelPet refund protocol. Read the
// current row's cumulative amounts exactly once, never sum every history row.
export function petSoulRefunds(tables, pet) {
    if (!pet.soul_link_level || pet.soul_link_level === '0') return []
    const { config, row } = petSoulRow(tables, pet),
        refunds = []
    for (const token of String(row.itemReturn ?? '')
        .split('|')
        .filter(Boolean)) {
        const a = token.split('#').map(Number)
        ensure(
            a.length === 3 &&
                a[0] === 3 &&
                Number.isSafeInteger(a[1]) &&
                a[1] > 0 &&
                Number.isSafeInteger(a[2]) &&
                a[2] > 0 &&
                tables.find('common_item', a[1]),
            'Invalid star-soul refund items',
            ErrorCode.GameConfig,
        )
        refunds.push({ itemtype: a[0], itemid: a[1], itemnum: a[2] })
    }
    ensure(
        Number.isSafeInteger(row.kiboItemReturn) && row.kiboItemReturn >= 0,
        'Invalid star-soul species refund',
        ErrorCode.GameConfig,
    )
    if (row.kiboItemReturn > 0) {
        ensure(
            Number.isInteger(config.starsoulItem) &&
                config.starsoulItem > 0 &&
                tables.find('common_item', config.starsoulItem),
            'Star-soul refund material unavailable',
            ErrorCode.GameConfig,
        )
        refunds.push({ itemtype: 3, itemid: config.starsoulItem, itemnum: row.kiboItemReturn })
    }
    return refunds
}
