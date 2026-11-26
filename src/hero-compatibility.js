import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Exact 1.0.0/3217420 hero ID export, not a fallback catalog. CBT3's
// 104001 was an owned Han Youyou variant. The current client has no row
// for it and HeroData.SetConfigIds does not remap normal server IDs.
const currentHeroIds = '50d8ec9351e1264d4bf59c86cc923f8f0c2953b0f6fee279bdf199f4df5b24d9'
export function currentHeroAvailable(tables, hero) {
    if (hero.abyss) return true // Snapshot attributes are resolved by heroModules, not the current hero table.
    if (tables.find('hero', hero.conf_id)) return true
    const ids = tables
        .get('hero')
        .map((row) => row.id)
        .sort((a, b) => a - b)
    const signature = createHash('sha256').update(JSON.stringify(ids)).digest('hex')
    ensure(
        hero.conf_id === 104001 && signature === currentHeroIds && !hero.trail && !hero.abyss,
        `Missing hero row ${hero.conf_id}`,
        ErrorCode.GameConfig,
    )
    return false
}

// Projection only: preserve owned heroes, equipment, favor and original group
// bindings in the save. A missing actor cannot enter this client's HeroStore.
export function projectCurrentHeroes(tables, state, player = state.player) {
    const unavailable = new Set(
        state.player.heros_info.heros
            .filter((hero) => !currentHeroAvailable(tables, hero))
            .map((hero) => String(hero.guid)),
    )
    if (!unavailable.size) return player
    const available = state.player.heros_info.heros.filter((hero) => !unavailable.has(String(hero.guid)))
    const fallback = String(available.find((hero) => hero.type === 1)?.guid ?? '0')
    return {
        ...player,
        ...(player.heros_info
            ? {
                  heros_info: {
                      ...player.heros_info,
                      heros: player.heros_info.heros?.filter((hero) => !unavailable.has(String(hero.guid))),
                      battle_infos: player.heros_info.battle_infos?.filter(
                          (hero) => !unavailable.has(String(hero.hero_id)),
                      ),
                  },
              }
            : {}),
        ...(player.group_mgrs
            ? {
                  group_mgrs: player.group_mgrs.map((manager) =>
                      [7, 8].includes(manager.type)
                          ? manager
                          : {
                                ...manager,
                                groups: manager.groups.map((group) => {
                                    let heros = (group.heros ?? []).map((slot) =>
                                        unavailable.has(String(slot.hero_id))
                                            ? { ...slot, hero_id: '0', pet_id: '0' }
                                            : slot,
                                    )
                                    let control = group.control
                                    if (unavailable.has(String(control))) {
                                        control = String(
                                            heros.find((slot) => String(slot.hero_id) !== '0')?.hero_id ?? '0',
                                        )
                                        if (control === '0' && manager.type === 1 && fallback !== '0' && heros.length) {
                                            heros = heros.map((slot, index) =>
                                                index ? slot : { ...slot, hero_id: fallback, pet_id: '0' },
                                            )
                                            control = fallback
                                        }
                                    }
                                    return { ...group, heros, control }
                                }),
                            },
                  ),
              }
            : {}),
    }
}

// Login migration: keep the complete original formation in a compatibility
// archive and make the normal runtime formation match the client projection.
// Equipment, hero/pet ownership and favor remain attached to their old GUIDs.
// Trial/abyss formations are managed by their own lifecycle and never rewritten.
export function suspendUnavailableHeroFormations(tables, state) {
    const projected = projectCurrentHeroes(tables, state)
    if (projected === state.player) return false
    let changed = false
    const unavailable = new Set(
        state.player.heros_info.heros
            .filter((hero) => !currentHeroAvailable(tables, hero))
            .map((hero) => String(hero.guid)),
    )
    for (const pet of state.pets ?? []) {
        if (!unavailable.has(String(pet.hero_id))) continue
        state.compatibilityDiagnostics ??= {}
        state.compatibilityDiagnostics.suspendedHeroPetBindings ??= {}
        state.compatibilityDiagnostics.suspendedHeroPetBindings[pet.guid] ??= { hero_id: pet.hero_id }
        pet.hero_id = '0'
        changed = true
    }
    for (const manager of state.player.group_mgrs) {
        if (manager.type !== 1) continue
        const next = projected.group_mgrs.find((entry) => entry.type === manager.type)
        for (let index = 0; index < manager.groups.length; index++) {
            const original = manager.groups[index],
                replacement = next.groups[index]
            if (JSON.stringify(original) === JSON.stringify(replacement)) continue
            state.compatibilityDiagnostics ??= {}
            state.compatibilityDiagnostics.suspendedHeroFormations ??= {}
            const key = `${manager.type}:${original.id}`
            state.compatibilityDiagnostics.suspendedHeroFormations[key] ??= {
                version: '1.0.0',
                reason: 'unavailableCurrentHero',
                group: structuredClone(original),
            }
            manager.groups[index] = replacement
            changed = true
        }
    }
    return changed
}
