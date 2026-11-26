import { starterProfileMode } from './starter-profile.js'

// Explicit sandbox/legacy policy: make configured usable cosmetics available.
// Ownership and equipped appearance are separate CBT3 data channels.
const catalogs = new WeakMap()
export function appearanceCatalog(tables) {
    if (!catalogs.has(tables)) {
        const clothes = tables
            .get('clothing_item')
            .filter(
                (row) =>
                    row.id > 0 &&
                    (row.clothingAvatarM ||
                        row.clothingAvatarF ||
                        row.weaponAvatarM ||
                        row.weaponAvatarF ||
                        row.resPathM ||
                        row.resPathF),
            )
        const skins = tables.get('hero_clothing').filter((row) => row.clothingid > 0 && row.hero > 0 && row.unitId > 0)
        const defaults = String(tables.get('game').find((row) => row.title === 'CLOTHING_DEFAULT_CONF')?.value ?? '')
            .split('|')
            .map((token) => {
                const [type, id] = token.split('#').map(Number)
                if (
                    !Number.isInteger(type) ||
                    !Number.isInteger(id) ||
                    !clothes.some((row) => row.id === id && row.typeId === type)
                )
                    throw Error('Invalid CLOTHING_DEFAULT_CONF')
                return { type, id }
            })
        catalogs.set(tables, {
            clothes: new Map(clothes.map((row) => [row.id, row])),
            skins: new Map(skins.map((row) => [row.clothingid, row])),
            defaults,
        })
    }
    return catalogs.get(tables)
}
export function ensureAppearance(tables, state) {
    const catalog = appearanceCatalog(tables)
    if (starterProfileMode(state) === 'normal') {
        // Current table names the two necessary default equip parts. Preserve
        // genuinely acquired lists; do not blanket-own the skin catalogue.
        state.unlockedClothes = [
            ...new Set([...(state.unlockedClothes ?? []), ...catalog.defaults.map((row) => row.id)]),
        ]
        state.unlockedHeroSkins ??= {}
        // Current HeroStore.HasHeroClothing/InitHeroClothing treat a row with
        // clothingid == hero as the universally available base appearance.
        // Mirror that only for actually owned heroes; never add other skins.
        for (const hero of state.player.heros_info.heros) {
            const base = catalog.skins.get(hero.conf_id)
            if (base?.hero !== hero.conf_id) continue
            const owned = (state.unlockedHeroSkins[hero.conf_id] ??= [])
            if (!owned.includes(base.clothingid)) owned.push(base.clothingid)
        }
        state.player.basic_info.clothes_info = normalizeClothes(tables, state.player.basic_info.clothes_info)
        return
    }
    state.unlockedClothes = [...new Set([...(state.unlockedClothes ?? []), ...catalog.clothes.keys()])]
    state.unlockedHeroSkins ??= {}
    const owned = new Set(
        state.player.heros_info.heros.filter((hero) => !hero.type || hero.type === 1).map((hero) => hero.conf_id),
    )
    for (const row of catalog.skins.values()) {
        if (!owned.has(row.hero)) continue
        const list = (state.unlockedHeroSkins[row.hero] ??= [])
        if (!list.includes(row.clothingid)) list.push(row.clothingid)
    }
    state.player.basic_info.clothes_info = normalizeClothes(tables, state.player.basic_info.clothes_info)
}
export function normalizeClothes(tables, info = {}) {
    const parts = [...(info?.parts ?? [])]
    // Native PageCustomClothes.SaveData uses Enumerable.First<int> for each
    // single-select slot. Empty costume/weapon data must not reach that path.
    // Restore required slots from game.CLOTHING_DEFAULT_CONF, preserving edits.
    for (const fallback of appearanceCatalog(tables).defaults) {
        const index = parts.findIndex((part) => part.type === fallback.type)
        if (index < 0) parts.push({ ...fallback })
        else if (!parts[index].id) parts[index] = { ...parts[index], id: fallback.id }
    }
    return { ...info, parts }
}
export function clothesSnapshot(tables, state) {
    const catalog = appearanceCatalog(tables)
    return { unlock_clothes: (state.unlockedClothes ?? []).filter((id) => catalog.clothes.has(id)) }
}
export function heroSkinsSnapshot(tables, state) {
    const catalog = appearanceCatalog(tables)
    return {
        hero_skin_info: Object.entries(state.unlockedHeroSkins ?? {}).map(([hero, ids]) => ({
            // Native SyncHeroClothingOwned keys this by config ID, not hero GUID.
            hero_id: String(hero),
            skin_id: ids.filter((id) => catalog.skins.get(id)?.hero === Number(hero)),
        })),
    }
}
