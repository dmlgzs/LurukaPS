import { ensure, textValue, pet } from './common.js'
import { ensurePetName } from '../pets.js'
import { caressPet } from '../pet-caress.js'
import { ensureHome } from '../home.js'
import { homeCondition } from '../home-grid.js'
import { reconcileFormationPets } from '../formation-pets.js'
import { mountPayload, repairMountSelection } from '../mounts.js'
import { syncBattle } from '../battle.js'
import { clearFarmPetSlots } from './farm-workers.js'
import { clearProductionPetSlots } from './production-workers.js'
import { rememberMap, worldSync, WORLD_MAP_CMD_ENTER } from './world.js'
import { dormTopics } from '../home-dorm.js'

function homeScenePosition(tables) {
    const homeMapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
    ensure(Number.isInteger(homeMapId) && homeMapId > 0, 'Missing home map id', 1007)

    const point = tables.get('world_borthpos').find((row) => row.cityId === homeMapId && Number(row.mainPoint) === 1)
    const area = tables.get('world_area').find((row) => row.sceneId === homeMapId)
    ensure(point && area, 'Missing home scene spawn configuration', 1007)

    return { ...tables.position(point), area_id: area.id }
}

export function registerHome(on, tables) {
    const change = (c) => {
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
    }
    on('PetCaress', (c, r) => {
        const homeMapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        ensure(c.state.world.map_id === homeMapId, 'Pet caress requires the home scene')
        const target = pet(c.state, r.u64),
            named = ensurePetName(tables, target),
            result = caressPet(tables, c.state, target, c.now)
        if (named || result.changed) {
            c.state.petRevision = (c.state.petRevision || 0) + 1
        }
        return result.response
    })
    on('PetStationInHomeHub', (c, r) => {
        const p = pet(c.state, r.pet_guid),
            home = ensureHome(tables, c.state),
            station = (home.stationPets ??= [])
        ensure(r.type === 0 || r.type === 1, 'Invalid home-hub pet action')
        if (r.type === 0) {
            if (station.includes(p.guid)) return {}
            const unlocked = Math.max(
                0,
                ...tables
                    .get('home_freeworkposition')
                    .filter((row) => homeCondition(row.unlockCondition, c.state))
                    .map((row) => row.num),
            )
            ensure(station.length < unlocked, 'Home-hub pet slots are full')
            ensure(!p.work_status || p.work_status === 7, 'Pet is working elsewhere')
            const bound = c.state.player.heros_info.heros.filter((hero) => hero.pet_id === p.guid)
            for (const hero of bound) hero.pet_id = '0'
            if (bound.length || (p.hero_id && p.hero_id !== '0')) {
                p.hero_id = '0'
                reconcileFormationPets(c.state)
                c.push('CSProtoSyncPlayerData', {
                    heros_info: c.state.player.heros_info,
                    group_mgrs: c.state.player.group_mgrs,
                })
            }
            if (c.state.world.mount === p.guid) {
                c.state.world.mount = '0'
                c.state.world.status = 0
            }
            p.roulette_pos = 0
            p.work_status = 7
            p.work_build = 0
            p.capacity_id = 0
            station.push(p.guid)
        } else {
            const index = station.indexOf(p.guid)
            if (index < 0 && p.work_status !== 7) return {}
            if (p.work_status === 5) clearFarmPetSlots(c.state, p.guid)
            if ([1, 2].includes(p.work_status)) clearProductionPetSlots(c.state, p.guid)
            if (index >= 0) station.splice(index, 1)
            if ([1, 2, 5, 7].includes(p.work_status)) {
                p.work_status = 0
                p.work_build = 0
                p.capacity_id = 0
            }
        }
        c.state.petRevision = (c.state.petRevision || 0) + 1
        if (repairMountSelection(tables, c.state)) c.push('CSProtoRideMountInfo', mountPayload(tables, c.state))
        change(c)
        return {}
    })
    on('EnterHome', (c, r) => {
        ensure(!r.creator_id || r.creator_id === c.id, 'Visiting other homes is not implemented', 1021)
        ensureHome(tables, c.state)
        const position = homeScenePosition(tables)
        rememberMap(c, position.map_id)
        Object.assign(c.state.world, position)
        delete c.state.combat
        change(c)
        const sceneContext = { ...c, push: c.pushBefore }
        c.pushBefore('SCProtoHomeHeroStoryInfoNtf', dormTopics(tables, c.state, c.now))
        // The client starts SceneService.EnterScene from WorldMapSync cmd 256.
        worldSync(sceneContext, r, WORLD_MAP_CMD_ENTER)
        syncBattle(sceneContext)
        return {}
    })
    on('SetHomeName', (c, r) => {
        ensureHome(tables, c.state).name = textValue(r.name, 30)
        change(c)
        return {}
    })
    on('HomeShortcutChange', (c, r) => {
        ensure(r.shortcut_bar.length > 0 && r.shortcut_bar.length <= 2, 'Invalid shortcut groups')
        const home = ensureHome(tables, c.state),
            types = new Set()
        for (const bar of r.shortcut_bar) {
            ensure([1, 2].includes(bar.type) && !types.has(bar.type), 'Invalid shortcut type')
            types.add(bar.type)
            ensure(bar.item_id.length <= 64, 'Too many shortcut slots')
            for (const id of bar.item_id) {
                ensure(Number.isInteger(id) && id >= -1, 'Invalid shortcut item')
                if (id > 0)
                    ensure(tables.find(bar.type === 1 ? 'home_building' : 'common_item', id), 'Unknown shortcut item')
            }
            const index = home.shortcuts.findIndex((x) => x.type === bar.type)
            if (bar.type === 1) {
                const oldIds = new Set((home.shortcuts[index]?.item_id ?? []).filter((id) => id > 0))
                const newIds = new Set(bar.item_id.filter((id) => id > 0))
                const suppressed = new Set(home.suppressedBuildShortcuts ?? [])
                for (const id of oldIds) if (!newIds.has(id)) suppressed.add(id)
                for (const id of newIds) suppressed.delete(id)
                home.suppressedBuildShortcuts = [...suppressed]
                home.autoBuildShortcutIds = (home.autoBuildShortcutIds ?? []).filter((id) => !oldIds.has(id))
            } else {
                const oldIds = new Set((home.shortcuts[index]?.item_id ?? []).filter((id) => id > 0))
                const newIds = new Set(bar.item_id.filter((id) => id > 0))
                const suppressed = new Set(home.suppressedCropShortcuts ?? [])
                for (const id of oldIds) if (!newIds.has(id)) suppressed.add(id)
                for (const id of newIds) suppressed.delete(id)
                home.suppressedCropShortcuts = [...suppressed]
                home.autoCropShortcutIds = (home.autoCropShortcutIds ?? []).filter((id) => newIds.has(id))
            }
            if (index < 0) home.shortcuts.push(bar)
            else home.shortcuts[index] = bar
        }
        change(c)
        return {}
    })
    on('AddHomeMaterialWishList', (c, r) => {
        const home = ensureHome(tables, c.state)
        ensure(tables.find('products', r.product_id), 'Unknown product')
        ensure(Number.isInteger(r.count) && r.count > 0, 'Invalid wishlist quantity')
        const limit = Number(tables.get('game').find((x) => x.title === 'HOME_WISHLIST_LIMIT')?.value)
        ensure(Number.isInteger(limit) && limit > 0, 'Invalid wishlist limit', 1007)
        if (r.uid) {
            const index = home.wishlist.findIndex((x) => x.uid === r.uid)
            ensure(index >= 0, 'Wishlist entry not owned')
            home.wishlist[index] = { ...r }
        } else {
            ensure(home.wishlist.length < limit, 'Wishlist is full')
            ensure(home.nextWishUid <= 0xffffffff, 'Wishlist identity exhausted')
            home.wishlist.push({ ...r, uid: home.nextWishUid++ })
        }
        change(c)
        return {}
    })
    on('DelHomeMaterialWishList', (c, r) => {
        const home = ensureHome(tables, c.state)
        ensure(
            home.wishlist.some((x) => x.uid === r.u32),
            'Wishlist entry not owned',
        )
        home.wishlist = home.wishlist.filter((x) => x.uid !== r.u32)
        change(c)
        return {}
    })
    for (const [name, value] of [
        ['TraceHomeMaterialWishList', true],
        ['UnTraceHomeMaterialWishList', false],
    ])
        on(name, (c, r) => {
            const row = ensureHome(tables, c.state).wishlist.find((x) => x.uid === r.u32)
            ensure(row, 'Wishlist entry not owned')
            row.trace = value
            change(c)
            return {}
        })
}
