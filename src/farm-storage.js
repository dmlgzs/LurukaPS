import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { ensureHome, ensureHomeFarmHouses } from './home.js'
import { findFarmWork } from './farm-work-context.js'
import { spend } from './inventory.js'
import { grantRewards } from './rewards.js'

const seedSlots = 12 // pageHomeCropBox.refreshBoxes: boxNum = 12.
export function farmHouse(tables, state, guid) {
    const home = ensureHome(tables, state),
        build = home.builds.find((b) => b.guid === guid)
    const config = build && tables.find('home_building', build.build_id)
    ensure(
        build?.locate &&
            build.status === 1 &&
            tables.get('home_building_group').some((g) => g.groupId === config?.groupId && g.type === 16),
        'Farm house is not owned/ready',
        ErrorCode.BuildPetAutoWorkInvalid,
    )
    ensureHomeFarmHouses(tables, state)
    return build
}
function seedConfig(tables, id) {
    const item = tables.find('common_item', id)
    ensure(item, 'Missing seed item configuration', ErrorCode.HomeSeedIdNotInItemConf)
    ensure(item.type === 310, 'Item is not a seed', ErrorCode.HomeSeedTypeError)
    const config = tables.find('home_seeds', item.subId)
    ensure(config, 'Missing seed configuration', ErrorCode.HomeSeedIdNotInSeedConf)
    ensure(
        config.harvestType === 1,
        'Perennial seed storage requires its dedicated lifecycle',
        ErrorCode.FunctionClosed,
    )
    const size = String(config.homeItemSize).split('|').map(Number)
    ensure(
        size.length === 2 && size.every((n) => n > 0 && n <= 2),
        'Seed cannot be planted by a farm worker',
        ErrorCode.HomeSeedCanNotPlantByKibo,
    )
    return config
}
function amount(count) {
    ensure(Number.isInteger(count) && count > 0 && count <= 0xffffffff, 'Invalid seed count', ErrorCode.InvalidArgument)
}
function allocate(state) {
    const next = BigInt(state.nextItemGuid || '1')
    ensure(next > 0n && next <= 0xffffffffffffffffn, 'Farm seed identity space exhausted', ErrorCode.InvalidLogic)
    state.nextItemGuid = String(next + 1n)
    return String(next)
}
function merge(list, items) {
    for (const item of items) {
        let target = list.find((x) => x.itemid === item.itemid && x.itemtype === item.itemtype)
        if (!target) {
            target = { ...item, itemnum: 0 }
            list.push(target)
        }
        ensure(target.itemnum + item.itemnum <= 0xffffffff, 'Farm storage quantity overflow', ErrorCode.InvalidArgument)
        target.itemnum += item.itemnum
    }
}
export function farmWorker(tables, state, field, slot) {
    const worker = findFarmWork(tables, state, field, slot)
    ensure(worker, 'No assigned farm worker for this field', ErrorCode.BuildPetAutoWorkInvalid)
    return worker.house
}
export function consumeFarmSeed(tables, state, house, id, count) {
    seedConfig(tables, id)
    const stacks = house.auto_info.seeds.filter((item) => item.itemid === id)
    ensure(
        stacks.reduce((n, item) => n + item.itemnum, 0) >= count,
        'Not enough seeds in the farm house',
        ErrorCode.SeedNumNotEnough,
    )
    for (const item of stacks) {
        const n = Math.min(item.itemnum, count)
        item.itemnum -= n
        count -= n
    }
    house.auto_info.seeds = house.auto_info.seeds.filter((item) => item.itemnum > 0)
}
export function storeFarmHarvest(house, rewards) {
    merge((house.auto_info.crops ??= []), rewards)
}
export function registerFarmStorage(on, tables) {
    const atHome = (c) =>
        ensure(
            c.state.world.map_id === Number(tables.get('game').find((r) => r.title === 'HOME_ID').value),
            'Farm storage requires the home scene',
            ErrorCode.InvalidArgument,
        )
    const deposit = (c, buildGuid, items) => {
        atHome(c)
        const house = farmHouse(tables, c.state, buildGuid),
            costs = new Map()
        ensure(items.length > 0 && items.length <= seedSlots, 'Invalid seed selection', ErrorCode.InvalidArgument)
        for (const item of items) {
            ensure(item.itemtype === 3, 'Invalid seed resource type', ErrorCode.HomeSeedTypeError)
            seedConfig(tables, item.itemid)
            amount(item.itemnum)
            costs.set(item.itemid, (costs.get(item.itemid) || 0) + item.itemnum)
        }
        const seeds = house.auto_info.seeds
        ensure(
            new Set([...seeds.map((x) => x.itemid), ...costs.keys()]).size <= seedSlots,
            'Farm seed store is full',
            ErrorCode.SeedStoreFull,
        )
        for (const [id] of costs)
            ensure(
                !c.state.player.sbag_infos.items.some(
                    (item) => item.itemid === id && item.itemnum > 0 && item.deadtime,
                ),
                'Timed seeds require expiry-preserving storage',
                ErrorCode.FunctionClosed,
            )
        spend(c.state, costs, 0, c.now)
        for (const [id, count] of costs) {
            let target = seeds.find((item) => item.itemid === id)
            if (!target) {
                target = { itemtype: 3, itemid: id, itemnum: 0, guid: allocate(c.state) }
                seeds.push(target)
            }
            ensure(target.itemnum + count <= 0xffffffff, 'Farm seed count overflow', ErrorCode.InvalidArgument)
            target.itemnum += count
        }
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    }
    on('QuickOperateSeedStore', (c, r) => deposit(c, r.build_guid, r.items))
    on('OperateSeedStorehouse', (c, r) => {
        if (r.operate_type === 1) return deposit(c, r.build_guid, [r.seed])
        atHome(c)
        ensure(r.operate_type === 2 && r.seed, 'Invalid seed store operation', ErrorCode.AutoWorkTypeInvaild)
        const house = farmHouse(tables, c.state, r.build_guid),
            item = house.auto_info.seeds.find(
                (x) =>
                    x.itemid === r.seed.itemid &&
                    (!r.seed.guid || r.seed.guid === '0' || String(x.guid) === String(r.seed.guid)),
            )
        amount(r.seed.itemnum)
        ensure(item && item.itemnum >= r.seed.itemnum, 'Not enough stored seeds', ErrorCode.SeedNumNotEnough)
        grantRewards(tables, c.state, [{ itemtype: 3, itemid: item.itemid, itemnum: r.seed.itemnum }])
        item.itemnum -= r.seed.itemnum
        house.auto_info.seeds = house.auto_info.seeds.filter((x) => x.itemnum > 0)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
    on('ExchangeSeedLoc', (c, r) => {
        atHome(c)
        const seeds = farmHouse(tables, c.state, r.build_guid).auto_info.seeds
        const a = seeds.findIndex((x) => String(x.guid) === String(r.guid)),
            b = seeds.findIndex((x) => String(x.guid) === String(r.target_guid))
        ensure(a >= 0 && b >= 0, 'Seed slot does not exist', ErrorCode.NoMatchSeed)
        ;[seeds[a], seeds[b]] = [seeds[b], seeds[a]]
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
    on('GetAutoWorkCropReward', (c, r) => {
        atHome(c)
        const house = farmHouse(tables, c.state, r.u32),
            items = house.auto_info.crops || []
        const exp = items
            .filter((item) => item.itemtype === 10 && item.itemid === 1003)
            .reduce((n, item) => n + item.itemnum, 0)
        const granted = items.length ? grantRewards(tables, c.state, items) : []
        house.auto_info.crops = []
        if (items.length) c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return { reward: { rewards: granted }, home_exp: exp }
    })
}
