import { ensure, hero } from './common.js'
import { ensureHome, homePayload } from '../home.js'
import {
    homeMapId,
    dormBuilding,
    dormCapacity,
    dormSceneConfig,
    syncDormResidents,
    dormBackground,
    dormPosition,
    activeDormVisit,
    dormTopics,
    claimDormTopic,
    addHeroFavorability,
    refreshDormGiftDay,
} from '../home-dorm.js'
import { spend } from '../inventory.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { worldSync, WORLD_MAP_CMD_ENTER } from './world.js'
import { syncBattle } from '../battle.js'
import { configTime } from '../shops.js'

function changed(c) {
    c.state.homeRevision = (c.state.homeRevision ?? 0) + 1
    c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
}
function scene(c, position) {
    c.previousMapId = c.state.world.map_id
    Object.assign(c.state.world, position)
    delete c.state.combat
    const before = { ...c, push: c.pushBefore }
    worldSync(before, {}, WORLD_MAP_CMD_ENTER)
    syncBattle(before)
}
function enter(c, build, actor) {
    const home = c.state.home,
        previous = activeDormVisit(c.tables, c.state)
    ensure(c.state.world.map_id === homeMapId(c.tables) || previous, 'Enter dormitory from home')
    ensure(
        build.dorm.dorm_heros.some((slot) => slot.hero_id === actor.guid),
        'Hero does not live in this dormitory',
    )
    const background = dormBackground(
        c.tables,
        c.state,
        actor,
        home.dorm.hero_back_ground.find((entry) => entry.hero_id === actor.guid)?.itemid ?? 0,
    )
    const position = dormPosition(c.tables, c.state, background)
    home.dormVisit = {
        build_guid: build.guid,
        hero_id: actor.guid,
        map_id: position.map_id,
        return_position: previous?.return_position ?? {
            map_id: c.state.world.map_id,
            point_id: c.state.world.point_id,
            pos: { ...c.state.world.pos },
            angle: c.state.world.angle,
            area_id: c.state.world.area_id,
        },
    }
    // HomeDormStore's 6217 handler sets the GUID used by OnInitDorm. It must
    // be bound before the destination scene creates its role/furniture.
    c.pushBefore('CSProtoHomeSync', homePayload(c.tables, c.state))
    c.pushBefore('SCProtoHomeHeroStoryInfoNtf', dormTopics(c.tables, c.state, c.now))
    c.pushBefore('SCProtoHomeDormReEnterNtf', { hero_id: actor.guid })
    scene(c, position)
}
export function registerHomeDorm(on, tables) {
    on('HomeDormCheckIn', (c, r) => {
        ensureHome(tables, c.state)
        const build = dormBuilding(tables, c.state, r.build_guid)
        const slots = build.dorm.dorm_heros,
            index = r.dorm_index
        ensure(
            Number.isInteger(index) && index >= 1 && index <= dormCapacity(tables, build),
            'Dorm slot is locked or invalid',
        )
        const incoming = String(r.hero_in ?? '0'),
            outgoing = String(r.hero_out ?? '0')
        ensure(incoming !== '0' || outgoing !== '0', 'Empty dorm operation')
        const existing = slots.find((slot) => slot.dorm_index === index)
        if (existing?.hero_id === incoming && incoming !== '0') return {}
        ensure((existing?.hero_id ?? '0') === outgoing, 'Dorm resident changed; refresh the slot')
        // Do not destroy the role currently being visited while its scene is live.
        const visit = activeDormVisit(tables, c.state)
        ensure(!visit || ![incoming, outgoing].includes(visit.hero_id), 'Cannot move the currently visited resident')
        if (incoming !== '0') {
            dormSceneConfig(tables, hero(c.state, incoming))
            // Moving a hero from another dorm vacates their old slot atomically.
            for (const entry of c.state.home.builds)
                if (entry.dorm)
                    entry.dorm.dorm_heros = entry.dorm.dorm_heros.filter((slot) => slot.hero_id !== incoming)
        }
        build.dorm.dorm_heros = build.dorm.dorm_heros.filter((slot) => slot.dorm_index !== index)
        if (incoming !== '0') build.dorm.dorm_heros.push({ hero_id: incoming, dorm_index: index })
        syncDormResidents(c.state)
        changed(c)
        return {}
    })
    on('HomeDormChangeName', (c, r) => {
        ensureHome(tables, c.state)
        // Dorm names are protobuf strings; home_name elsewhere is bytes.
        ensure(
            typeof r.name === 'string' && r.name.trim().length > 0 && [...r.name].length <= 7 && !r.name.includes('\0'),
            'Invalid dorm name',
        )
        dormBuilding(tables, c.state, r.build_guid).dorm.name = r.name
        c.state.homeRevision = (c.state.homeRevision ?? 0) + 1
        return {}
    })
    on('HomeDormEnter', (c, r) => {
        ensureHome(tables, c.state)
        enter(c, dormBuilding(tables, c.state, r.build_guid), hero(c.state, r.hero_id))
        return {}
    })
    on('HomeDormQuit', (c) => {
        const visit = activeDormVisit(tables, c.state)
        if (!visit) {
            delete c.state.home?.dormVisit
            return {}
        }
        ensure(visit.return_position?.map_id === homeMapId(tables), 'Dorm return position is not home')
        delete c.state.home.dormVisit
        scene(c, visit.return_position)
        return {}
    })
    on('ChangeHeroBackGround', (c, r) => {
        ensureHome(tables, c.state)
        const build = dormBuilding(tables, c.state, r.build_guid),
            actor = hero(c.state, r.hero_id)
        ensure(
            build.dorm.dorm_heros.some((slot) => slot.hero_id === actor.guid),
            'Hero does not live in this dormitory',
        )
        const background = dormBackground(tables, c.state, actor, r.itemid ?? 0)
        const data = c.state.home.dorm
        data.hero_back_ground = data.hero_back_ground.filter((entry) => entry.hero_id !== actor.guid)
        data.hero_back_ground.push(background)
        c.state.homeRevision = (c.state.homeRevision ?? 0) + 1
        const visit = activeDormVisit(tables, c.state)
        if (r.is_change && visit) enter(c, build, actor)
        return {}
    })
    on('HomeHeroDressUp', (c, r) => {
        ensureHome(tables, c.state)
        const actor = hero(c.state, r.hero_id)
        const background = dormBackground(tables, c.state, actor, r.item_id ?? 0)
        const data = c.state.home.dorm
        data.hero_pajamas = data.hero_pajamas.filter((entry) => entry.hero_id !== actor.guid)
        data.hero_pajamas.push({ hero_id: actor.guid, pajamas_itemid: background.itemid })
        c.state.homeRevision = (c.state.homeRevision ?? 0) + 1
        return {}
    })
    on('HomeHeroStoryReward', (c, r) => {
        const reply = claimDormTopic(tables, c.state, r.storys, c.now)
        c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        c.pushBefore('SCProtoHomeHeroStoryInfoNtf', dormTopics(tables, c.state, c.now))
        return reply
    })
    on('HomeFurnitureRecommend', (c) => {
        return {
            id: tables
                .get('shop_furniture_recommend')
                .filter((row) => {
                    const start = configTime(row.startTime),
                        end = configTime(row.endTime)
                    return (!start || c.now >= start) && (!end || c.now < end)
                })
                .map((row) => row.id),
        }
    })
    on('SendHeroGift', (c, r) => {
        ensureHome(tables, c.state)
        refreshDormGiftDay(tables, c.state, c.now)
        const actor = c.state.player.heros_info.heros.find((entry) => entry.conf_id === r.heroId)
        ensure(actor, 'Gift recipient is not owned')
        const item = tables.find('common_item', r.item_id)
        // item_type is common_item.type (110/111), not reward resource type 3.
        ensure(item && [110, 111].includes(item.type) && r.item_type === item.type, 'Invalid hero gift category')
        ensure(Number.isInteger(r.num) && r.num > 0, 'Invalid gift quantity')
        let favor
        if (item.type === 111) {
            const furniture = tables.find('home_dorm_furniture', item.id)
            ensure(furniture?.heroId === actor.conf_id, 'Furniture belongs to another hero')
            ensure(r.num === 1 && !actor.furnitures?.includes(item.id), 'Furniture has already been given')
            favor = furniture.value
        } else {
            const gift = tables.find('hero_favorability_gift', item.id)
            ensure(gift, 'Gift configuration is missing', 1007)
            const basic = c.state.player.basic_info
            const perHero = Number(tables.get('game').find((row) => row.title === 'HERO_FAVORABILITY_GIFT_NUM')?.value)
            const total = Number(
                tables.get('game').find((row) => row.title === 'HERO_FAVORABILITY_ALL_GIFT_NUM')?.value,
            )
            ensure(
                (actor.daily_gift_num ?? 0) + r.num <= perHero && basic.hero_gift_info.gift_num + r.num <= total,
                'Daily hero gift limit reached',
            )
            favor =
                (String(gift.favourHero).split('|').map(Number).includes(actor.conf_id)
                    ? gift.favourValue
                    : gift.normalValue) * r.num
        }
        spend(c.state, new Map([[item.id, r.num]]), 0, c.now)
        addHeroFavorability(tables, actor, favor)
        if (item.type === 111) (actor.furnitures ??= []).push(item.id)
        else {
            actor.daily_gift_num = (actor.daily_gift_num ?? 0) + r.num
            c.state.player.basic_info.hero_gift_info.gift_num += r.num
            c.state.player.basic_info.hero_gift_info.last_time = c.now
        }
        c.pushBefore('CSProtoSyncPlayerData', {
            heros_info: c.state.player.heros_info,
            basic_info: c.state.player.basic_info,
        })
        return { item_id: item.id, hero_id: actor.conf_id, item_type: item.type, num: r.num }
    })
    on('GotFavorReward', (c, r) => {
        const actor = hero(c.state, r.u64),
            pending = actor.store_favor_rewards ?? []
        const rewards = []
        for (const id of pending) {
            const info = tables.find('hero_favorability_info', id)
            ensure(
                info?.heroId === actor.conf_id && info.favorabilityLevel <= actor.favorability_lv,
                'Invalid pending favorability reward',
                1007,
            )
            rewards.push(...parseRewards(info.reward))
        }
        const granted = grantRewards(tables, c.state, rewards)
        actor.store_favor_rewards = []
        c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        return { rewards: granted }
    })
}
