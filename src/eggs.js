import { ErrorCode } from './error-codes.js'
import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { constrainedEggPools } from './egg-pools.js'
function weights(text) {
    return String(text || '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [id, weight, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length && Number.isInteger(id) && id >= 0 && Number.isInteger(weight) && weight > 0,
                'Invalid egg weight configuration',
                ErrorCode.GameConfig,
            )
            return { id, weight }
        })
}
function choose(list, rng) {
    const total = list.reduce((n, x) => n + x.weight, 0)
    ensure(Number.isSafeInteger(total) && total > 0 && total < 2 ** 48, 'Invalid egg weight sum', ErrorCode.GameConfig)
    let draw = rng(total)
    ensure(Number.isInteger(draw) && draw >= 0 && draw < total, 'Random source out of range')
    for (const x of list) {
        if (draw < x.weight) return x.id
        draw -= x.weight
    }
    throw Error('Random source out of range')
}
export function eggRewardDefinition(tables, id, constraints = undefined) {
    const config = tables.find('pet_egg', id)
    ensure(config, 'Unknown pet egg', ErrorCode.EggConfNotExist)
    if (constraints) constrainedEggPools(tables, id, constraints)
    const quantities = weights(config.affixquantityweight), pool = weights(config.affixweight)
    ensure(quantities.length > 0, 'Missing egg affix count config', ErrorCode.GameConfig)
    for (const entries of [quantities, pool]) {
        const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
        ensure(Number.isSafeInteger(total) && total < 2 ** 48 && (!entries.length || total > 0), 'Invalid egg weight sum', ErrorCode.GameConfig)
    }
    ensure(new Set(pool.map((x) => x.id)).size === pool.length, 'Duplicate egg affix definition', ErrorCode.GameConfig)
    const groups = new Set()
    for (const entry of pool) {
        const row = tables.find('egg_affix', entry.id)
        ensure(row, 'Missing egg affix', ErrorCode.GameConfig)
        groups.add(row.mutexgroup ? `group:${row.mutexgroup}` : `affix:${entry.id}`)
    }
    ensure(quantities.every((x) => x.id <= groups.size), 'Unsatisfiable egg affix pool', ErrorCode.GameConfig)
    return { config, quantities, pool }
}
export function createEggs(tables, state, id, count, rng = randomInt, constraints = undefined) {
    const { quantities, pool } = eggRewardDefinition(tables, id, constraints)
    const limit = Number(tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS')?.value)
    ensure(Number.isInteger(limit) && limit > 0, 'Invalid egg capacity', ErrorCode.GameConfig)
    state.petEggs ??= []
    ensure(Number.isInteger(count) && count > 0 && state.petEggs.length + count <= limit, 'Pet egg bag is full')
    const existingMax = state.petEggs.reduce((n, e) => Math.max(n, e.guid), 0)
    let next = Math.max(state.nextEggGuid || 1, existingMax + 1)
    ensure(Number.isSafeInteger(next) && next + count - 1 <= 0xffffffff, 'Egg GUID space exhausted')
    const eggs = []
    for (let i = 0; i < count; i++) {
        const wanted = choose(quantities, rng),
            selected = [],
            groups = new Set()
        let available = pool.slice()
        for (let j = 0; j < wanted; j++) {
            available = available.filter((x) => {
                const cfg = tables.find('egg_affix', x.id)
                ensure(cfg, 'Missing egg affix', ErrorCode.GameConfig)
                return !selected.includes(x.id) && (!cfg.mutexgroup || !groups.has(cfg.mutexgroup))
            })
            ensure(available.length > 0, 'Unsatisfiable egg affix pool', ErrorCode.GameConfig)
            const affix = choose(available, rng)
            selected.push(affix)
            const group = tables.find('egg_affix', affix).mutexgroup
            if (group) groups.add(group)
        }
        eggs.push({ guid: next++, configid: id, hatch_state: 0, lock_state: false, egg_affix: selected })
        if (constraints) (state.eggHatchConstraints ??= {})[eggs.at(-1).guid] = { ...constraints }
    }
    state.petEggs.push(...eggs)
    state.nextEggGuid = next
    state.eggRevision = (state.eggRevision || 0) + 1
    return eggs
}

// Earlier local seeds used UI PetEggState.Idle (1), but wire PEHS_NORMAL is 0.
// Preserve records associated with a hatch building; their queue state is meaningful.
export function upgradeEggState(state) {
    if ((state.eggSchemaVersion || 0) >= 2) return
    let changed = false
    for (const egg of state.petEggs || [])
        if (egg.hatch_state === 1 && !egg.hatch_build_guid) {
            egg.hatch_state = 0
            changed = true
        }
    if (changed) state.eggRevision = (state.eggRevision || 0) + 1
    state.eggSchemaVersion = 2
}
