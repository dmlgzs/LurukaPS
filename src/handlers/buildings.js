import { ensureHome, ensureHomeCanteens, ensureHomeFarmHouses, refreshAutoBuildShortcut } from '../home.js'
import { validatePlacement } from '../home-grid.js'
import { ensure } from './common.js'
import { ensureHomeDormitories, syncDormResidents, activeDormVisit } from '../home-dorm.js'
function inactive(build) {
    return (
        build.status === 1 &&
        !(build.product || []).length &&
        ![build.auto_info?.plant_pet, build.auto_info?.water_pet, build.auto_info?.harvest_pet].some(
            (guid) => guid && guid !== '0',
        ) &&
        (!build.station_pet_guid || build.station_pet_guid === '0') &&
        !(build.hatch?.hatch_infos || []).some((x) => x.egg_guid) &&
        !(build.batch_hatch?.slots || []).some((x) => x.egg_guid)
    )
}
export function registerBuildingPlacement(on, tables) {
    const placeBuild = (c, r) => {
        const home = ensureHome(tables, c.state)
        home.storedBuilds ??= []
        let build = r.guid
            ? home.builds.find((b) => b.guid === r.guid) || home.storedBuilds.find((b) => b.guid === r.guid)
            : null
        ensure(!r.guid || build, 'Building instance not owned')
        const id = r.build_id || build?.build_id
        ensure(id && (!build || build.build_id === id), 'Building identity mismatch')
        const inventory = home.inventory.find((x) => x.build_id === id)
        ensure(inventory?.unlock, 'Building not unlocked or owned')
        const placed = !!build && home.builds.includes(build)
        ensure(placed || inventory.used_num < inventory.total_num, 'No building in inventory')
        if (build) ensure(inactive(build), 'Building is busy')
        const group = validatePlacement(tables, c.state, id, r.locate, placed ? build.guid : 0)
        if (!build) build = home.storedBuilds.find((b) => b.build_id === id)
        if (!build) {
            const max = [...home.builds, ...home.storedBuilds].reduce((n, b) => Math.max(n, b.guid), 0)
            const guid = Math.max(home.nextBuildGuid || 1, max + 1)
            ensure(guid <= 0xffffffff, 'Building GUID space exhausted')
            home.nextBuildGuid = guid + 1
            build = { guid, build_id: id, build_type: group.type, status: 1 }
        }
        build.locate = { ...r.locate, direction: r.locate.direction ?? 0 }
        if (!placed) {
            home.storedBuilds = home.storedBuilds.filter((b) => b.guid !== build.guid)
            home.builds.push(build)
            inventory.used_num++
            refreshAutoBuildShortcut(home, id)
        }
        ensureHomeCanteens(tables, c.state)
        ensureHomeFarmHouses(tables, c.state)
        ensureHomeDormitories(tables, c.state)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return build
    }
    on('BuildLocate', placeBuild)
    on('BuildCreate', placeBuild)
    on('BuildUnlocate', (c, r) => {
        const home = ensureHome(tables, c.state),
            build = home.builds.find((b) => b.guid === r.guid)
        ensure(build, 'Building instance not owned')
        ensure(inactive(build), 'Building is busy')
        const config = tables.find('home_building', build.build_id),
            group = tables.get('home_building_group').find((g) => g.groupId === config.groupId)
        ensure(group?.isStorable === 1, 'Building cannot be stored')
        ensure(activeDormVisit(tables, c.state)?.build_guid !== build.guid, 'Cannot store the dormitory being visited')
        const inventory = home.inventory.find((x) => x.build_id === build.build_id)
        ensure(inventory && inventory.used_num > 0, 'Invalid building inventory')
        inventory.used_num--
        refreshAutoBuildShortcut(home, build.build_id)
        home.builds = home.builds.filter((b) => b.guid !== r.guid)
        home.storedBuilds ??= []
        const stored = { ...build }
        if (stored.dorm) {
            stored.dorm = { ...stored.dorm, hero_ids: [], dorm_heros: [] }
            syncDormResidents(c.state)
            c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        }
        delete stored.locate
        home.storedBuilds.push(stored)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
