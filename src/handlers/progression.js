import { ErrorCode } from '../error-codes.js'
import { recordActiveProgress } from '../daily-active.js'
import { ensure, hero, pet, syncPlayer, syncPets } from './common.js'
import { aggregateCosts, spend } from '../inventory.js'
import { syncBattle } from '../battle.js'
function gameValue(tables, key) {
    const row = tables.get('game').find((r) => r.title === key)
    ensure(row, `Missing game setting ${key}`, ErrorCode.GameConfig)
    return row.value
}
export function maximumLevel(rows, playerLevel) {
    let max = 1
    for (const row of rows.slice().sort((a, b) => a.lv - b.lv)) {
        if (row.lv <= 1) continue
        ensure(row.lv === max + 1, 'Non-contiguous level table', ErrorCode.GameConfig)
        const condition = String(row.condition || '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        if (condition.length) {
            ensure(condition.length === 2 && condition[0] === 2004, 'Unsupported level condition', ErrorCode.GameConfig)
            if (playerLevel < condition[1]) break
        }
        max = row.lv
    }
    return max
}
export function advanceLevel(rows, level, experience, gain, cap) {
    ensure(Number.isSafeInteger(gain) && gain > 0, 'Invalid experience')
    ensure(level < cap, 'Already at level cap')
    let exp = experience + gain
    ensure(Number.isSafeInteger(exp) && exp <= 0xffffffff, 'Experience overflow')
    const byLevel = new Map(rows.map((r) => [r.lv, r]))
    while (level < cap) {
        const need = byLevel.get(level)?.exp
        ensure(Number.isSafeInteger(need) && need > 0, 'Invalid level curve', ErrorCode.GameConfig)
        if (exp < need) break
        exp -= need
        level++
    }
    return { level, exp }
}
export function registerProgression(on) {
    for (const kind of ['Hero', 'Pet'])
        on(`LvUp${kind}`, (c, r) => {
            const isHero = kind === 'Hero',
                entity = isHero ? hero(c.state, r.hero_id) : pet(c.state, r.pet_id)
            const costs = aggregateCosts(r.items),
                allowed = isHero
                    ? [400000, 400001, 400002, 400003]
                    : String(gameValue(c.tables, 'PET_EXPITEMID')).split('|').map(Number)
            let gain = 0
            for (const [id, count] of costs) {
                ensure(allowed.includes(id), 'Not an experience material')
                const config = c.tables.find('common_item', id)
                const exp = Number(config?.useFunction)
                ensure(Number.isSafeInteger(exp) && exp > 0, 'Invalid material config', ErrorCode.GameConfig)
                gain += exp * count
                ensure(Number.isSafeInteger(gain), 'Experience overflow')
            }
            const rows = c.tables.get(isHero ? 'hero_level' : 'pet_level'),
                cap = maximumLevel(rows, c.state.player.basic_info.lv)
            const result = advanceLevel(
                rows,
                isHero ? entity.hero_lv : entity.lv,
                isHero ? entity.hero_exp : entity.exp,
                gain,
                cap,
            )
            const ratio = Number(gameValue(c.tables, isHero ? 'HERO_LEVELUP_GOLD' : 'PET_LEVELUP_GOLD'))
            ensure(Number.isSafeInteger(ratio) && ratio >= 0, 'Invalid gold ratio', ErrorCode.GameConfig)
            const product = BigInt(gain) * BigInt(ratio)
            const gold = Number(product / 10000n)
            ensure(Number.isSafeInteger(gold), 'Gold cost overflow')
            const changed = spend(c.state, costs, gold, c.now)
            const previousLevel = isHero ? entity.hero_lv : entity.lv
            if (isHero) {
                entity.hero_lv = result.level
                entity.hero_exp = result.exp
            } else {
                entity.lv = result.level
                entity.exp = result.exp
                c.state.petRevision = (c.state.petRevision ?? 0) + 1
            }
            if (result.level > previousLevel && !entity.trail && entity.type !== 2)
                recordActiveProgress(c.tables, c.state, isHero ? 15000 : 15002, 1, c.now)
            syncPlayer(c, {
                basic_info: c.state.player.basic_info,
                sbag_infos: { items: changed },
                ...(isHero ? { heros_info: c.state.player.heros_info } : {}),
            })
            if (!isHero) syncPets(c)
            syncBattle(c)
            return { rewards: [] }
        })
}
