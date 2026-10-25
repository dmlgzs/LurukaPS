import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import { ensureCollectionData } from './home-collection.js'
import { worldCollectionConfiguration } from './world-collection.js'
import { collectionDropIds } from './collection-drop.js'

export function collectionClaimTargets(state, guids) {
    ensure(
        Array.isArray(guids) &&
            guids.length > 0 &&
            guids.length <= 1024 &&
            guids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff) &&
            new Set(guids).size === guids.length,
        'Invalid collection building selection',
        ErrorCode.InvalidArgument,
    )
    const targets = []
    for (const guid of guids) {
        const home = (state.home?.builds ?? []).filter(
            (b) => b.guid === guid && b.build_type === 24 && b.locate && [1, 4].includes(b.status),
        )
        const world = Object.values(state.home?.worldCollections ?? {}).filter((b) => b.guid === guid)
        ensure(home.length + world.length <= 1, 'Collection building identity is ambiguous', ErrorCode.GameConfig)
        ensure(
            home.length + world.length === 1,
            'Collection building is not owned or ready',
            ErrorCode.CollectBuildNotExist,
        )
        const entry = home[0] ?? world[0]
        targets.push({ guid, type: home.length ? 24 : 55, entry, data: home.length ? entry.collect_build_data : entry })
    }
    return targets
}
function validateStock(tables, targets) {
    return targets.flatMap((target) => {
        if (target.type === 55) {
            const config = worldCollectionConfiguration(tables, target.entry.collect_id)
            ensure(
                config.building.id === target.entry.build_id,
                'Saved world collection building does not match its point',
                ErrorCode.GameConfig,
            )
        } else
            ensure(
                tables.find('home_building_homecollection', target.entry.build_id),
                'Missing home collection building definition',
                ErrorCode.GameConfig,
            )
        const items = target.data?.items ?? []
        ensure(Array.isArray(items), 'Invalid collection stock list', ErrorCode.GameConfig)
        return items.map((item) => {
            ensure(
                [item.item_id, item.item_type, item.item_num, item.source_product_id].every(
                    (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff,
                ),
                'Invalid saved collection reward',
                ErrorCode.GameConfig,
            )
            const product = tables.find('products_collection', item.source_product_id)
            ensure(product, 'Collection reward product is missing', ErrorCode.CollectProductConfNotFound)
            const drop = tables.find('home_drop', product.homeDropId)
            ensure(drop, 'Collection reward drop is missing', ErrorCode.CollectDropConfNotFound)
            ensure(
                drop.itemType === item.item_type && collectionDropIds(tables, drop).includes(item.item_id),
                'Collection reward does not match its product',
                ErrorCode.CollectProductnotMatch,
            )
            ensure(
                [3, 10, 14].includes(item.item_type),
                'Collection reward type requires support',
                ErrorCode.FunctionClosed,
            )
            return { target, item, drop }
        })
    })
}
export function mergeCollectionRewards(rewards) {
    const result = [],
        shared = new Map()
    for (const item of rewards) {
        if (item.guid) {
            result.push(item)
            continue
        }
        const key = item.itemtype + ':' + item.itemid
        let merged = shared.get(key)
        if (!merged) {
            merged = { ...item, itemnum: 0 }
            shared.set(key, merged)
            result.push(merged)
        }
        ensure(merged.itemnum + item.itemnum <= 0xffffffff, 'Collection reward quantity overflow', ErrorCode.GameConfig)
        merged.itemnum += item.itemnum
    }
    return result
}
// Both 6529 and the home-centre aggregate claim use this stock transaction.
// It does not send presentation notifications: each caller owns its reply.
export function claimCollectionStock(c, targets, { allowEmpty = false } = {}) {
    const rows = validateStock(c.tables, targets)
    ensure(rows.length > 0 || allowEmpty, 'Collection storage is empty', ErrorCode.CollectRewardNull)
    const eggs = rows.filter(({ item }) => item.item_type === 14).reduce((n, { item }) => n + item.item_num, 0)
    if (eggs) {
        const limit = Number(c.tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS')?.value)
        ensure(Number.isSafeInteger(limit) && limit > 0, 'Invalid egg capacity configuration', ErrorCode.GameConfig)
        ensure((c.state.petEggs?.length ?? 0) + eggs <= limit, 'Pet egg inventory is full', ErrorCode.EggBagNumIsMax)
    }
    const byType = new Map()
    for (const { target, item, drop } of rows) {
        const eggConstraints =
            item.item_type === 14 && (drop.elementTypeId || drop.raceId)
                ? {
                      element_type: drop.elementTypeId ?? 0,
                      race: drop.raceId ?? 0,
                      product_id: item.source_product_id,
                      drop_id: drop.id,
                  }
                : undefined
        const rewards = grantRewards(
            c.tables,
            c.state,
            [{ itemtype: item.item_type, itemid: item.item_id, itemnum: item.item_num }],
            0,
            { randomInt: c.randomInt, eggConstraints },
        )
        if (!byType.has(target.type)) byType.set(target.type, [])
        byType.get(target.type).push(...rewards)
    }
    for (const target of targets) target.data.items = []
    if (rows.length) c.state.homeRevision = (c.state.homeRevision || 0) + 1
    return new Map([...byType].map(([type, rewards]) => [type, mergeCollectionRewards(rewards)]))
}
export function claimCollections(c, request) {
    ensure(
        !(request.source_build ?? 0),
        'Collection source-building variant requires support',
        ErrorCode.FunctionClosed,
    )
    ensureCollectionData(c.state)
    const targets = collectionClaimTargets(c.state, request.guid)
    const groups = claimCollectionStock(c, targets)
    return {
        rewards: mergeCollectionRewards([...groups.values()].flat()),
        src: rewardSource(c.tables, 'collectionHarvest'),
    }
}
