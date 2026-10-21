import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { specialAttributes } from './battle.js'

const catalogs = new WeakMap()
function catalog(tables) {
    if (!catalogs.has(tables)) {
        const groups = new Map(),
            entries = new Map(),
            max = new Map()
        for (const row of tables.get('accessory_skillEntry')) {
            if (!groups.has(row.groupId)) groups.set(row.groupId, [])
            groups.get(row.groupId).push(row)
        }
        for (const row of tables.get('skill_entry')) {
            const key = row.skillEntryId + ':' + row.skillLv
            ensure(!entries.has(key), 'Duplicate skill-entry level', ErrorCode.GameConfig)
            entries.set(key, row)
            max.set(row.skillEntryId, Math.max(max.get(row.skillEntryId) ?? 0, row.skillLv))
        }
        const levelOne = new Set(
            tables
                .get('skill_level')
                .filter((row) => row.level === 1)
                .map((row) => row.skillId),
        )
        catalogs.set(tables, { groups, entries, max, levelOne })
    }
    return catalogs.get(tables)
}
export function ornamentGradeEntries(tables, item) {
    const grade = item.grade === undefined ? 0 : item.grade // Optional Ornament.grade defaults to zero on wire.
    ensure(Number.isSafeInteger(grade) && grade >= 0, 'Invalid saved ornament star', ErrorCode.GameConfig)
    const config = tables.find('accessory', item.id)
    ensure(config, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
    if (!config.subAttr) return []
    const rows = catalog(tables).groups.get(config.subAttr)
    ensure(rows?.length, 'Ornament entry group unavailable', ErrorCode.OrnamentConfFail)
    const slots = new Map()
    for (const row of rows) {
        ensure(Number.isSafeInteger(row.star) && row.star >= 0, 'Invalid ornament entry star', ErrorCode.GameConfig)
        if (row.star > grade) continue
        const old = slots.get(row.subAttrId)
        if (!old || row.star > old.star) slots.set(row.subAttrId, row)
    }
    return [...slots.values()]
}

// Current client: select the last unlocked star per subAttrId, sum the skill
// levels across equipment, then cap each entry by its own GetMaxSkillLv.
// Only skill_entry.skillId is a battle skill. The entry ID itself is not.
export function ornamentEntryEffects(tables, items) {
    if (!items.length) return { attrs: new Map(), skills: [], entries: [] }
    const data = catalog(tables),
        levels = new Map()
    for (const item of items)
        for (const row of ornamentGradeEntries(tables, item)) {
            ensure(
                Number.isSafeInteger(row.skillId) &&
                    row.skillId > 0 &&
                    Number.isSafeInteger(row.skillLv) &&
                    row.skillLv > 0,
                'Invalid ornament skill-entry reference',
                ErrorCode.GameConfig,
            )
            ensure(
                data.entries.has(row.skillId + ':' + row.skillLv),
                'Ornament skill-entry level unavailable',
                ErrorCode.GameConfig,
            )
            const sum = (levels.get(row.skillId) ?? 0) + row.skillLv
            ensure(Number.isSafeInteger(sum), 'Ornament skill-entry level overflow', ErrorCode.GameConfig)
            levels.set(row.skillId, sum)
        }
    const attrs = new Map(),
        skills = new Set(),
        entries = []
    for (const [id, total] of levels) {
        const level = Math.min(total, data.max.get(id)),
            row = data.entries.get(id + ':' + level)
        ensure(row, 'Merged ornament entry unavailable', ErrorCode.GameConfig)
        for (const text of String(row.mainAttr || '')
            .split('|')
            .filter(Boolean)) {
            const [key, value, ...rest] = text.split('#').map(Number)
            ensure(
                !rest.length && Number.isSafeInteger(key) && key > 0 && Number.isFinite(value),
                'Invalid ornament entry attribute',
                ErrorCode.GameConfig,
            )
            const packed = value * (specialAttributes.has(key) ? 10000 : 1)
            const sum = (attrs.get(key) ?? 0) + packed
            ensure(
                Number.isFinite(sum) && Math.abs(sum) <= Number.MAX_SAFE_INTEGER,
                'Ornament entry attribute overflow',
                ErrorCode.GameConfig,
            )
            attrs.set(key, sum)
        }
        ensure(
            Number.isSafeInteger(row.skillId) &&
                row.skillId >= 0 &&
                Number.isSafeInteger(row.subSkillId) &&
                row.subSkillId >= 0,
            'Invalid ornament entry skill reference',
            ErrorCode.GameConfig,
        )
        ensure(row.subSkillId === 0, 'Ornament entry sub-skill variant not implemented', ErrorCode.FunctionClosed)
        if (row.skillId) {
            ensure(
                tables.find('skill', row.skillId) && data.levelOne.has(row.skillId),
                'Ornament battle skill unavailable',
                ErrorCode.GameConfig,
            )
            skills.add(row.skillId)
        }
        entries.push({ entryId: id, level, total, row })
    }
    return {
        attrs,
        skills: [...skills].map((skill_id) => ({ skill_id, skill_lv: 1, skill_slot: 0, type: 0 })),
        entries,
    }
}
