import { ErrorCode } from '../error-codes.js'
import { ensureHome } from '../home.js'
import { spend, addItems } from '../inventory.js'
import { ensure } from './common.js'
import { canteenFoodScore, readCanteenFoodLedger } from '../canteen-food-ledger.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0

function validateBag(state, items, withdraw) {
    const bag = state.player.sbag_infos.items
    ensure(Array.isArray(bag), 'Invalid food inventory', ErrorCode.GameConfig)
    for (const [id, count] of items) {
        const stacks = bag.filter((entry) => entry.itemid === id)
        for (const entry of stacks)
            ensure(
                uint(entry.itemnum) &&
                    (entry.itemtype === undefined || entry.itemtype === 3) &&
                    (entry.deadtime === undefined || uint(entry.deadtime)),
                'Invalid food inventory stack',
                ErrorCode.GameConfig,
            )
        const destination = stacks.find((entry) => !entry.deadtime)
        if (withdraw && destination)
            ensure(
                uint(destination.itemnum + count),
                'Food refund count overflows inventory wire value',
                ErrorCode.GameConfig,
            )
    }
}

export function registerCanteen(on, tables) {
    on('AddPetFood', (c, r) => {
        const homeMapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        ensure(positive(homeMapId), 'Home scene configuration is invalid', ErrorCode.GameConfig)
        ensure(c.state.world.map_id === homeMapId, 'Pet table requires the home scene', ErrorCode.PlayerNotInHome)
        const home = ensureHome(tables, c.state)
        ensure(positive(r.build_guid), 'Invalid pet table identity', ErrorCode.HomeBuildGuidInvild)
        ensure(Array.isArray(home.builds), 'Invalid owned building list', ErrorCode.GameConfig)
        const matches = home.builds.filter((entry) => entry.guid === r.build_guid)
        ensure(matches.length > 0, 'Pet table is not owned', ErrorCode.HomeBuildGuidInvild)
        ensure(matches.length === 1, 'Duplicate owned building identity', ErrorCode.GameConfig)
        const build = matches[0]
        ensure(build.build_type === 6, 'Building is not a pet table', ErrorCode.BuildTypeNotMatch)
        ensure(
            build.locate && [1, 4].includes(build.status),
            'Pet table is not placed',
            ErrorCode.HomeBuildInvalidStatus,
        )
        const config = tables.find('home_building', build.build_id)
        ensure(config, 'Pet table configuration is missing', ErrorCode.BuildConfNotFound)
        const group = tables.get('home_building_group').find((entry) => entry.groupId === config.groupId)
        ensure(group, 'Pet table group configuration is missing', ErrorCode.BuildGroupConfNotFound)
        ensure(group.type === 6, 'Pet table configuration has another building type', ErrorCode.BuildTypeNotMatch)
        ensure(positive(home.level), 'Saved cultivation home level is invalid', ErrorCode.GameConfig)
        const level = tables.find('home_level', home.level)
        ensure(level, 'Home level configuration is missing', ErrorCode.HomeLvConfigNotFound)
        ensure(
            positive(config.trough) &&
                config.trough <= 0x7fffffff &&
                uint(level.table_food_max) &&
                level.table_food_max <= 0x7fffffff,
            'Pet table capacity configuration is invalid',
            ErrorCode.GameConfig,
        )
        // CBT3 GetSatietyScoreInfo -> DataUtil -> HomeUtil(enum4): cultivation
        // home_level.table_food_max is added once to this building's trough.
        const capacity = config.trough + level.table_food_max
        ensure(capacity <= 0x7fffffff, 'Pet table capacity sum overflows the client int32', ErrorCode.GameConfig)
        ensure(
            [0, 1].includes(r.operate_type) && Array.isArray(r.items) && r.items.length > 0 && r.items.length <= 32,
            'Invalid pet food operation',
            ErrorCode.InvalidArgument,
        )
        const items = new Map()
        for (const entry of r.items) {
            ensure(
                positive(entry.itemid) &&
                    positive(entry.itemnum) &&
                    (entry.itemtype === undefined || entry.itemtype === 3),
                'Invalid food quantity or type',
                ErrorCode.InvalidArgument,
            )
            canteenFoodScore(tables, entry.itemid)
            const count = (items.get(entry.itemid) ?? 0) + entry.itemnum
            ensure(positive(count), 'Food request quantity overflow', ErrorCode.InvalidArgument)
            items.set(entry.itemid, count)
        }
        const canteen = build.pet_canteen ?? {
            pets: [],
            food_value: 0,
            foods: [],
            food_extra_ids: [],
            food_extra_values: [],
        }
        const foods = readCanteenFoodLedger(tables, canteen)
        for (const [id, count] of items) {
            const old = foods.get(id) ?? 0
            if (r.operate_type === 0)
                ensure(old >= count, 'Food is not stocked in this pet table', ErrorCode.PetFoodSubFail)
            const next = old + (r.operate_type === 1 ? count : -count)
            ensure(uint(next), 'Pet table item capacity exceeded', ErrorCode.HomeFoodOver)
            if (next) foods.set(id, next)
            else foods.delete(id)
        }
        const foodValue = [...foods].reduce(
            (sum, [id, count]) => sum + BigInt(count) * BigInt(canteenFoodScore(tables, id, true)),
            0n,
        )
        ensure(foodValue <= BigInt(capacity), 'Pet table food capacity exceeded', ErrorCode.HomeFoodOver)
        validateBag(c.state, items, r.operate_type === 0)
        if (r.operate_type === 1) spend(c.state, items, 0, c.now)
        else
            addItems(
                c.state,
                [...items].map(([itemid, itemnum]) => ({ itemid, itemnum })),
            )
        build.pet_canteen = {
            ...canteen,
            food_value: Number(foodValue),
            foods: [...foods].map(([itemid, itemnum]) => ({ itemid, itemnum, itemtype: 3 })),
        }
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
