import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { ensureHome } from './home.js'
import { productionTables } from './production-tables.js'
import { claimProductionStock } from './production-claims.js'
import { claimFarmStorage } from './farm-storage.js'
import { collectionClaimTargets, claimCollectionStock, mergeCollectionRewards } from './collection-claims.js'
import { ensureCollectionData } from './home-collection.js'
import { rewardSource } from './reward-source.js'

function targets(c, guids) {
    ensure(
        Array.isArray(guids) &&
            guids.length > 0 &&
            guids.length <= 1024 &&
            guids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff) &&
            new Set(guids).size === guids.length,
        'Invalid aggregate building selection',
        ErrorCode.InvalidArgument,
    )
    const tables = productionTables(c.tables),
        home = ensureHome(c.tables, c.state)
    const result = { production: [], farms: [], collection: [] }
    for (const guid of guids) {
        const builds = home.builds.filter((b) => b.guid === guid)
        const worlds = Object.values(home.worldCollections ?? {}).filter((b) => b.guid === guid)
        const ranches = Object.values(home.ranches ?? {}).filter((b) => b.guid === guid)
        ensure(
            builds.length + worlds.length + ranches.length <= 1,
            'Home building identity is ambiguous',
            ErrorCode.GameConfig,
        )
        ensure(builds.length + worlds.length + ranches.length === 1, 'Building is not owned', ErrorCode.HomeNoBuild)
        // Native ReqReceiveAllBuildingDataInHomeCenter skips ranch tab3 and
        // incubation group3023. A stale/explicit selection cannot claim them.
        if (ranches.length) continue
        if (worlds.length) {
            result.collection.push(guid)
            continue
        }
        const build = builds[0]
        ensure(build.locate, 'Building is not placed', ErrorCode.HomeNoBuild)
        ensure([1, 4].includes(build.status), 'Building is under construction', ErrorCode.HomeBuildInvalidStatus)
        const config = tables.find('home_building', build.build_id)
        const group = config && tables.get('home_building_group').find((g) => g.groupId === config.groupId)
        ensure(
            config && group && group.type === build.build_type,
            'Missing or inconsistent building definition',
            ErrorCode.GameConfig,
        )
        if (config.groupId === 3023) continue
        if (build.build_type === 24) result.collection.push(guid)
        else if (build.build_type === 16) result.farms.push(guid)
        else {
            ensure(
                tables.find('home_building_production', build.build_id),
                'Building has no aggregate claim implementation',
                ErrorCode.FunctionClosed,
            )
            result.production.push(build)
        }
    }
    return result
}

export function claimAllBuildRewards(c, request) {
    const selected = targets(c, request.build_guid)
    ensureCollectionData(c.state)
    const groups = new Map()
    const add = (type, award) => {
        if (!award.rewards.length) return
        if (!groups.has(type)) groups.set(type, { rewards: [], sources: new Set(), unspecified: false })
        const group = groups.get(type)
        group.rewards.push(...award.rewards)
        if (award.src === undefined) group.unspecified = true
        else group.sources.add(award.src)
    }
    for (const build of selected.production)
        add(
            build.build_type,
            claimProductionStock(c, { guid: build.guid, is_all: true }, { allowEmpty: true, includeHatch: false })
                .reward,
        )
    for (const guid of selected.farms) add(16, claimFarmStorage(c, guid).reward)
    if (selected.collection.length) {
        const rewards = claimCollectionStock(c, collectionClaimTargets(c.state, selected.collection), {
            allowEmpty: true,
        })
        for (const [type, items] of rewards)
            add(type, { rewards: items, src: rewardSource(c.tables, 'collectionHarvest') })
    }
    // The client writes Dictionary[type] = rewards. Multiple same-type rows
    // would hide all earlier buildings, so merge actual granted results first.
    const base = [...groups].map(([type, group]) => ({
        type,
        award: {
            rewards: mergeCollectionRewards(group.rewards),
            ...(group.sources.size === 1 && !group.unspecified ? { src: [...group.sources][0] } : {}),
        },
    }))
    const exp = base
        .flatMap((g) => g.award.rewards)
        .filter((r) => r.itemtype === 10 && r.itemid === 1003)
        .reduce((n, r) => n + r.itemnum, 0)
    ensure(
        Number.isSafeInteger(exp) && exp <= 0xffffffff,
        'Aggregate home experience display overflow',
        ErrorCode.GameConfig,
    )
    // Actual XP was already granted once by the shared ledgers. The current
    // callback extracts it from each award; do not issue duplicate new_awards.
    return { base, home_exp: exp, new_awards: [] }
}
