import { technologyPayload } from './technology.js'
import { ensure } from './handlers/common.js'
import { ensureHomeDormitories, dormPayload } from './home-dorm.js'
export function ensureHome(tables, state) {
    if (state.home) return state.home
    const raw = tables.get('game').find((x) => x.title === 'HOME_DEFAULT_PLACEMENT')?.value
    const values = String(raw || '')
        .split('|')
        .map(Number)
    ensure(
        values.length === 5 && values.every(Number.isInteger) && values[0] === 13,
        'Invalid default home placement',
        1007,
    )
    const [, id, block, anchor, direction] = values,
        config = tables.find('home_building', id)
    ensure(config && tables.find('home_block', block), 'Missing initial home configuration', 1007)
    const group = tables.get('home_building_group').find((g) => g.groupId === config.groupId)
    ensure(group, 'Missing home building group', 1007)
    state.home = {
        name: Buffer.from('我的家园').toString('base64'),
        level: state.player.basic_info.home_lv || 1,
        exp: 0,
        inventory: [{ build_id: id, total_num: 1, used_num: 1, unlock: true }],
        builds: [
            {
                guid: 1,
                build_id: id,
                build_type: group.type,
                status: 1,
                locate: { block_id: block, anchor, direction },
            },
        ],
        shortcuts: [],
        wishlist: [],
        nextBuildGuid: 2,
        nextWishUid: 1,
    }
    state.homeRevision = (state.homeRevision || 0) + 1
    return state.home
}

export function ensureHomeCanteens(tables, state) {
    const home = ensureHome(tables, state)
    let changed = false
    for (const build of home.builds) {
        const config = tables.find('home_building', build.build_id)
        const group = config && tables.get('home_building_group').find((row) => row.groupId === config.groupId)
        if (group?.type !== 6 || build.pet_canteen) continue
        // The client only creates HomeBuildSatiety for type-6 builds carrying
        // pet_canteen. Without this empty object it reports capacity 0/0.
        build.pet_canteen = {
            pets: [],
            food_value: 0,
            foods: [],
            food_extra_ids: [],
            food_extra_values: [],
        }
        changed = true
    }
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return changed
}
export function ensureHomeFarmHouses(tables, state) {
    const home = ensureHome(tables, state)
    let changed = false
    for (const build of [...home.builds, ...(home.storedBuilds ?? [])]) {
        const config = tables.find('home_building', build.build_id)
        const group = config && tables.get('home_building_group').find((row) => row.groupId === config.groupId)
        if (group?.type !== 16 || build.auto_info) continue
        // CBT3 HomeBuildData.Populate calls HomeBuildAutoData.Populate without
        // a null check for field houses. An unstaffed house still needs this
        // empty message in both placement replies and home snapshots.
        build.auto_info = {
            plant_pet: '0',
            water_pet: '0',
            harvest_pet: '0',
            seeds: [],
            crops: [],
            got_crops: [],
            water_target: 0,
            slot_satiety_reduce: [],
        }
        changed = true
    }
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return changed
}
export function homePayload(tables, state) {
    const h = ensureHome(tables, state)
    ensureHomeFarmHouses(tables, state)
    ensureHomeDormitories(tables, state)
    // The CBT3 client's getBeltItems starts zero-filling at #list, overwriting
    // the last entry unless the wire list already has the full slot count.
    const shortcutSlots = Math.max(
        ...tables
            .get('game')
            .filter((row) => row.title === 'HOME_BELT_NUM_PC' || row.title === 'HOME_BELT_NUM_MOBILE')
            .map((row) => Number(row.value)),
    )
    ensure(Number.isInteger(shortcutSlots) && shortcutSlots > 0, 'Invalid home shortcut capacity', 1007)
    return {
        technology: technologyPayload(tables, state),
        home_lv: h.level,
        home_name: h.name,
        builds: h.inventory,
        home_builds: h.builds,
        dorm: dormPayload(tables, state),
        shortcut_bars: h.shortcuts.map((bar) => ({
            ...bar,
            item_id: Array.from(
                { length: Math.max(shortcutSlots, bar.item_id.length) },
                (_, index) => bar.item_id[index] ?? 0,
            ),
        })),
        wishlist: h.wishlist,
        formula: Object.entries(h.craftCounts || {}).map(([id, count]) => ({
            product_id: Number(id),
            craft_count: count,
        })),
        home_hub: { pos_infos: [], station_pets: h.stationPets ?? [] },
        home_level_new_base: { level: h.level, exp: h.exp, option_setting: 0 },
    }
}

function addShortcut(home, type, id) {
    let bar = home.shortcuts.find((entry) => entry.type === type)
    if (!bar) {
        bar = { type, item_id: [] }
        home.shortcuts.push(bar)
    }
    if (bar.item_id.includes(id)) return false
    const empty = bar.item_id.findIndex((item) => item <= 0)
    if (empty >= 0) bar.item_id[empty] = id
    else if (bar.item_id.length < 32) bar.item_id.push(id)
    else return false
    return true
}

export function refreshAutoBuildShortcut(home, id) {
    const available = home.inventory.find((building) => building.build_id === id)
    const autoIds = (home.autoBuildShortcutIds ??= [])
    const bar = home.shortcuts.find((entry) => entry.type === 1)
    if (available?.unlock && available.total_num > available.used_num) {
        if (!home.suppressedBuildShortcuts?.includes(id) && addShortcut(home, 1, id)) autoIds.push(id)
    } else if (autoIds.includes(id)) {
        if (bar) bar.item_id = bar.item_id.map((item) => (item === id ? 0 : item))
        home.autoBuildShortcutIds = autoIds.filter((item) => item !== id)
    }
}

export function refreshAutoCropShortcut(tables, state, id) {
    const item = tables.find('common_item', id)
    if (!item || item.type !== 310 || !tables.get('home_seeds').some((seed) => seed.id === item.subId)) return false
    const home = ensureHome(tables, state)
    const count = state.player.sbag_infos.items
        .filter((entry) => entry.itemid === id)
        .reduce((sum, entry) => sum + entry.itemnum, 0)
    const autoIds = (home.autoCropShortcutIds ??= [])
    const bar = home.shortcuts.find((entry) => entry.type === 2)
    if (count > 0) {
        if (home.suppressedCropShortcuts?.includes(id) || !addShortcut(home, 2, id)) return false
        autoIds.push(id)
    } else if (autoIds.includes(id)) {
        if (bar) bar.item_id = bar.item_id.map((entry) => (entry === id ? 0 : entry))
        home.autoCropShortcutIds = autoIds.filter((entry) => entry !== id)
    } else return false
    state.homeRevision = (state.homeRevision || 0) + 1
    return true
}

export function pruneAutoCropShortcuts(state) {
    const home = state.home
    if (!home?.autoCropShortcutIds?.length) return
    const owned = new Set(state.player.sbag_infos.items.filter((item) => item.itemnum > 0).map((item) => item.itemid))
    const removed = home.autoCropShortcutIds.filter((id) => !owned.has(id))
    if (!removed.length) return
    const bar = home.shortcuts.find((entry) => entry.type === 2)
    if (bar) bar.item_id = bar.item_id.map((id) => (removed.includes(id) ? 0 : id))
    home.autoCropShortcutIds = home.autoCropShortcutIds.filter((id) => owned.has(id))
    state.homeRevision = (state.homeRevision || 0) + 1
}

export function reconcileHomeCropShortcuts(tables, state) {
    ensureHome(tables, state)
    const ids = new Set([
        ...state.player.sbag_infos.items.map((entry) => entry.itemid),
        ...(state.home.autoCropShortcutIds ?? []),
    ])
    for (const id of ids) refreshAutoCropShortcut(tables, state, id)
}

export function reconcileHomeBuildShortcuts(tables, state) {
    const home = ensureHome(tables, state)
    if (home.buildShortcutVersion === 2) return
    if (home.buildShortcutVersion === 1) {
        const bar = home.shortcuts.find((entry) => entry.type === 1)
        if (bar) {
            bar.item_id = bar.item_id.map((id) => {
                const building = home.inventory.find((entry) => entry.build_id === id)
                return building?.unlock && building.total_num > building.used_num ? id : 0
            })
            home.autoBuildShortcutIds = bar.item_id.filter((id) => id > 0)
        }
    }
    for (const building of home.inventory)
        if (
            building.unlock &&
            building.total_num > building.used_num &&
            tables.find('home_building', building.build_id)
        )
            refreshAutoBuildShortcut(home, building.build_id)
    home.buildShortcutVersion = 2
    state.homeRevision = (state.homeRevision || 0) + 1
}

export function addHomeBuildings(tables, state, id, count) {
    const config = tables.find('home_building', id)
    ensure(config, 'Unknown building reward', 1007)
    const home = ensureHome(tables, state)
    let row = home.inventory.find((b) => b.build_id === id)
    if (!row) {
        row = { build_id: id, total_num: 0, used_num: 0, unlock: true }
        home.inventory.push(row)
    }
    ensure(row.total_num + count <= 0xffffffff, 'Building quantity overflow')
    row.total_num += count
    if (count > 0) row.unlock = true
    if (count > 0) refreshAutoBuildShortcut(home, id)
    state.homeRevision = (state.homeRevision || 0) + 1
}
