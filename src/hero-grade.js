import rows from '../configs/hero-grade-tables/hero_grade.json' with { type: 'json' }
import effects from '../configs/hero-grade-tables/hero_grade_effect.json' with { type: 'json' }
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// 2451868 differs from the old external export in 46 nonzero mainAttr rows.
// Keep the source CRC/SHA alongside this narrowly scoped runtime override.
export function heroGradeRows(heroId) {
    return rows.filter((row) => row.heroId === heroId).sort((a, b) => a.grade - b.grade)
}
export function heroGradeElementIds(heroId) {
    const ids = new Set()
    for (const row of effects.filter((entry) => entry.heroId === heroId))
        for (const id of String(row.gradeSkill || '')
            .split('|')
            .filter(Boolean)
            .map(Number)) {
            ensure(Number.isSafeInteger(id) && id > 0, 'Invalid hero grade element', ErrorCode.HeroGradeConfigInvalid)
            ids.add(id)
        }
    return ids
}
export function heroGradeEffects(hero) {
    const configured = heroGradeRows(hero.conf_id)
    // Some non-playable trial actors have no hero_grade rows. Their other
    // trial attributes remain in their existing source, not a fabricated tier.
    if (!configured.length) return { attrs: new Map(), skills: [], elements: [], switches: new Map() }
    const grade = hero.hero_grade ?? 0
    ensure(
        Number.isInteger(grade) && grade >= 0 && grade <= configured.at(-1).grade,
        'Invalid saved hero grade',
        ErrorCode.GameConfig,
    )
    const attrs = new Map(),
        switches = new Map(),
        elements = []
    for (let tier = 0; tier <= grade; tier++) {
        const row = configured.find((row) => row.grade === tier)
        ensure(row, 'Missing hero grade tier', ErrorCode.HeroGradeConfigInvalid)
        for (const token of String(row.mainAttr || '')
            .split('|')
            .filter(Boolean)) {
            const [id, amount, ...extra] = token.split('#').map(Number)
            ensure(
                !extra.length && Number.isSafeInteger(id) && id > 0 && Number.isFinite(amount),
                'Invalid hero grade attribute',
                ErrorCode.HeroGradeConfigInvalid,
            )
            attrs.set(id, (attrs.get(id) ?? 0) + amount)
        }
    }
    // mainSkill is a hero_grade_effect key, not a battle skill ID. Native
    // InitHeroGradeElement/ReplaceHeroGradeSkill reads the current tier only;
    // these effect rows already contain cumulative lists.
    const current = configured.find((row) => row.grade === grade)
    for (const key of String(current.mainSkill || '')
        .split('|')
        .filter(Boolean)
        .map(Number)) {
        const effect = effects.find((row) => row.id === key && row.heroId === hero.conf_id)
        ensure(effect, 'Hero grade effect unavailable', ErrorCode.HeroGradeConfigInvalid)
        for (const id of String(effect.gradeSkill || '')
            .split('|')
            .filter(Boolean)
            .map(Number)) {
            ensure(Number.isSafeInteger(id) && id > 0, 'Invalid hero grade element', ErrorCode.HeroGradeConfigInvalid)
            if (!elements.includes(id)) elements.push(id)
        }
        for (const token of String(effect.switchSkill || '')
            .split('|')
            .filter(Boolean)) {
            const [from, to, ...extra] = token.split('#').map(Number)
            ensure(
                !extra.length && [from, to].every((id) => Number.isSafeInteger(id) && id > 0),
                'Invalid hero grade skill replacement',
                ErrorCode.HeroGradeConfigInvalid,
            )
            switches.set(from, to)
        }
    }
    // Runtime grade elements are supplied by11904's owned-element lifecycle;
    // never serialize their config keys as UnitSkillInfo skills.
    return { attrs, skills: [], elements, switches }
}
export function nextHeroGrade(tables, hero) {
    const config = tables.find('hero', hero.conf_id)
    ensure(config?.isUsable === 1, 'Hero grade configuration unavailable', ErrorCode.HeroGradeConfigInvalid)
    const grade = hero.hero_grade ?? 0,
        maximum = Number(tables.get('game').find((row) => row.title === 'HERO_MAX_GRADE')?.value)
    ensure(
        Number.isSafeInteger(maximum) && maximum > 0 && Number.isInteger(grade) && grade >= 0,
        'Invalid hero grade progression',
        ErrorCode.GameConfig,
    )
    ensure(grade < maximum, 'Hero grade limit reached', ErrorCode.HeroGradeMax)
    const costs = String(config.gradeUpItem || '')
        .split('|')
        .filter(Boolean)
    ensure(costs.length === maximum, 'Hero grade costs unavailable', ErrorCode.HeroGradeConfigInvalid)
    const [id, count, ...extra] = costs[grade].split('#').map(Number)
    ensure(
        !extra.length &&
            Number.isSafeInteger(id) &&
            id > 0 &&
            Number.isSafeInteger(count) &&
            count > 0 &&
            tables.find('common_item', id),
        'Invalid hero grade cost',
        ErrorCode.HeroGradeConfigInvalid,
    )
    const reward = heroGradeRows(hero.conf_id).find((row) => row.grade === grade + 1)
    ensure(reward, 'Next hero grade configuration unavailable', ErrorCode.HeroGradeConfigInvalid)
    return { grade: grade + 1, costs: new Map([[id, count]]), reward: reward.reward }
}
