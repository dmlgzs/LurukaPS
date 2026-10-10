import { randomInt } from 'node:crypto'
import { ensure, hero } from './handlers/common.js'

const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export const homeMapId = (tables) => Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
export function dormSceneConfig(tables, actor) {
    const row = tables.get('home_dorm_scene').find((row) => row.heroId === actor.conf_id)
    ensure(row?.canEnterDorm === 1, 'Hero has no available dorm scene')
    return row
}
export function dormCapacity(tables, build) {
    const row = tables.find('home_building', build.build_id)
    const group = row && tables.get('home_building_group').find((entry) => entry.groupId === row.groupId)
    ensure(group?.type === 5, 'Building is not a dormitory')
    // CBT3 PageHomeDormitory.RefreshData reads this field, not the older
    // home_building_dorm.checkInMax (which disagrees with both CBT3 buildings).
    ensure(Number.isInteger(row.dormCharacterNum) && row.dormCharacterNum > 0, 'Invalid dorm capacity', 1007)
    return row.dormCharacterNum
}
export function ensureHomeDormitories(tables, state) {
    const home = state.home
    if (!home) return false
    let changed = false
    if (!home.dorm) {
        home.dorm = { hero_pajamas: [], back_ground_scene: { rewards: [] }, hero_back_ground: [] }
        changed = true
    }
    // Offline availability policy, like ensureAppearance: configured styles
    // for owned heroes are available immediately. Publish ownership as well
    // as accepting the request; CBT3 gates its buttons on this wire list.
    const owned = new Set(
        state.player.heros_info.heros.filter((actor) => !actor.type || actor.type === 1).map((actor) => actor.conf_id),
    )
    const rewards = home.dorm.back_ground_scene.rewards
    for (const item of tables.get('home_dorm_item')) {
        if (!owned.has(item.heroId)) continue
        const scene = tables.get('home_dorm_scene').find((row) => row.heroId === item.heroId && row.canEnterDorm === 1)
        const index = scene ? list(scene.unlockItem).indexOf(item.id) : -1
        if (
            index < 0 ||
            ![list(scene.exclusivedormScene)[index], list(scene.exclusivedormSceneNight)[index]].every(
                (id) => Number.isInteger(id) && tables.find('world_city', id)?.type === 21,
            )
        )
            continue
        const existing = rewards.find((entry) => entry.itemid === item.id)
        if (existing?.itemnum > 0) continue
        const unlocked = { itemtype: 40, itemid: item.id, itemnum: 1 }
        if (existing) Object.assign(existing, unlocked)
        else rewards.push(unlocked)
        changed = true
    }
    for (const build of [...home.builds, ...(home.storedBuilds ?? [])]) {
        const row = tables.find('home_building', build.build_id)
        const group = row && tables.get('home_building_group').find((entry) => entry.groupId === row.groupId)
        if (group?.type !== 5) continue
        if (!build.dorm) {
            build.dorm = { block_id: build.locate?.block_id ?? 0, name: '', hero_ids: [], dorm_heros: [] }
            changed = true
        }
        build.dorm.hero_ids ??= []
        build.dorm.dorm_heros ??= build.dorm.hero_ids.map((hero_id, i) => ({ hero_id, dorm_index: i + 1 }))
        const block = build.locate?.block_id ?? 0
        if (build.dorm.block_id !== block) {
            build.dorm.block_id = block
            changed = true
        }
    }
    if (changed) state.homeRevision = (state.homeRevision ?? 0) + 1
    return changed
}
export function dormBuilding(tables, state, guid) {
    ensureHomeDormitories(tables, state)
    const build = state.home?.builds.find((entry) => entry.guid === guid)
    ensure(build?.locate && build.status === 1, 'Dormitory is not placed or ready')
    dormCapacity(tables, build)
    return build
}
export function syncDormResidents(state) {
    const residence = new Map()
    for (const build of state.home.builds) {
        if (!build.dorm) continue
        build.dorm.dorm_heros.sort((a, b) => a.dorm_index - b.dorm_index)
        build.dorm.hero_ids = build.dorm.dorm_heros.map((slot) => slot.hero_id)
        for (const slot of build.dorm.dorm_heros) residence.set(slot.hero_id, build.guid)
    }
    for (const actor of state.player.heros_info.heros) actor.dorm_id = residence.get(actor.guid) ?? 0
}
export function dormBackground(tables, state, actor, itemid = 0) {
    const row = dormSceneConfig(tables, actor)
    let sceneid = row.sceneId,
        night_sceneid = row.sceneIdNight
    if (itemid) {
        const index = list(row.unlockItem).indexOf(itemid)
        ensure(
            index >= 0 && tables.find('home_dorm_item', itemid)?.heroId === actor.conf_id,
            'Dorm style belongs to another hero',
        )
        ensure(
            state.home.dorm.back_ground_scene.rewards.some((entry) => entry.itemid === itemid && entry.itemnum > 0),
            'Dorm style is not owned',
        )
        sceneid = list(row.exclusivedormScene)[index]
        night_sceneid = list(row.exclusivedormSceneNight)[index]
    }
    ensure(
        [sceneid, night_sceneid].every((id) => Number.isInteger(id) && tables.find('world_city', id)?.type === 21),
        'Missing dorm day/night scenes',
        1007,
    )
    return { hero_id: actor.guid, sceneid, night_sceneid, itemid }
}
export function dormPayload(tables, state) {
    ensureHomeDormitories(tables, state)
    const data = state.home.dorm
    return {
        ...data,
        hero_back_ground: state.player.heros_info.heros
            .filter((actor) =>
                tables.get('home_dorm_scene').some((row) => row.heroId === actor.conf_id && row.canEnterDorm === 1),
            )
            .map((actor) =>
                dormBackground(
                    tables,
                    state,
                    actor,
                    data.hero_back_ground.find((entry) => entry.hero_id === actor.guid)?.itemid ?? 0,
                ),
            ),
    }
}
export function grantDormStyle(tables, state, itemid) {
    ensure(tables.find('home_dorm_item', itemid), 'Unknown dorm style', 1007)
    ensureHomeDormitories(tables, state)
    const rewards = state.home.dorm.back_ground_scene.rewards
    if (rewards.some((entry) => entry.itemid === itemid)) return
    rewards.push({ itemtype: 40, itemid, itemnum: 1 })
    state.homeRevision = (state.homeRevision ?? 0) + 1
}
export function dormPosition(tables, state, background) {
    // GameTime.DoWorldTimeSync sends floor(TimeOfDay)+1; zero means unset.
    const reported = state.world.world_time ?? state.player.basic_info.world_time ?? 0
    const hour =
        (reported > 0 ? reported - 1 : Number(tables.get('game').find((row) => row.title === 'WORLD_TIME')?.value)) % 24
    const daytime = String(tables.get('game').find((row) => row.title === 'LOADING_DAYTIME')?.value)
        .split(',')
        .map(Number)
    ensure(
        daytime.length === 2 && daytime.every(Number.isFinite) && Number.isFinite(hour),
        'Invalid dorm time configuration',
        1007,
    )
    const map = hour >= daytime[0] && hour < daytime[1] ? background.sceneid : background.night_sceneid
    const point = tables.get('world_borthpos').find((row) => row.cityId === map && row.mainPoint === 1)
    ensure(point, 'Dorm scene spawn is missing', 1007)
    return tables.position(point)
}
export function activeDormVisit(tables, state) {
    const visit = state.home?.dormVisit
    if (!visit || visit.map_id !== state.world.map_id || tables.find('world_city', state.world.map_id)?.type !== 21)
        return null
    const build = state.home.builds.find((entry) => entry.guid === visit.build_guid)
    if (!build?.dorm?.dorm_heros.some((slot) => slot.hero_id === visit.hero_id)) return null
    return visit
}
function refreshDay(tables, now) {
    const hour = Number(tables.get('game').find((row) => row.title === 'DAILY_REFRESH_TIME')?.value)
    ensure(Number.isFinite(hour), 'Missing daily refresh hour', 1007)
    return Math.floor((now + (8 - hour) * 3600) / 86400)
}
export function dormDayDue(tables, state, now) {
    return !!state.home?.dormTopics && state.home.dormTopics.day !== refreshDay(tables, now)
}
export function refreshDormGiftDay(tables, state, now) {
    const day = refreshDay(tables, now),
        basic = state.player.basic_info
    if (state.home.dormGiftDay === day) return
    const last = basic.hero_gift_info?.last_time
    if (!last || refreshDay(tables, last) !== day) {
        basic.hero_gift_info = { gift_num: 0, last_time: now }
        for (const actor of state.player.heros_info.heros) actor.daily_gift_num = 0
    }
    state.home.dormGiftDay = day
}
export function addHeroFavorability(tables, actor, amount) {
    ensure(
        Number.isSafeInteger(amount) && amount >= 0 && amount <= 0xffffffff,
        'Invalid hero favorability reward',
        1007,
    )
    const levels = new Map(
        tables.get('hero_favorability_exp').map((row) => [row.favorabilityLevel, row.favorabilityExp]),
    )
    const max = Math.max(...levels.keys())
    let level = actor.favorability_lv ?? 0,
        exp = actor.favorability_exp ?? 0
    const reward = level < max ? amount : 0
    exp += reward
    while (level < max) {
        const required = levels.get(level)
        ensure(Number.isInteger(required) && required > 0, 'Invalid hero favorability curve', 1007)
        if (exp < required) break
        exp -= required
        level++
        const info = tables
            .get('hero_favorability_info')
            .find((row) => row.heroId === actor.conf_id && row.favorabilityLevel === level)
        if (info?.reward) {
            actor.store_favor_rewards ??= []
            if (!actor.store_favor_rewards.includes(info.id)) actor.store_favor_rewards.push(info.id)
        }
    }
    actor.favorability_lv = level
    actor.favorability_exp = level === max ? 0 : exp
    return reward
}
export function dormTopics(tables, state, now, rng = randomInt) {
    refreshDormGiftDay(tables, state, now)
    const day = refreshDay(tables, now)
    const topics = (state.home.dormTopics ??= { day, heroes: {} })
    if (topics.day !== day) {
        topics.day = day
        topics.heroes = {}
    }
    const storys = []
    for (const actor of state.player.heros_info.heros) {
        const row = tables.get('home_dorm_scene').find((row) => row.heroId === actor.conf_id && row.canEnterDorm === 1)
        const choices = String(row?.dailyStory ?? '')
            .split('|')
            .filter(Boolean)
            .map((entry) => entry.split('#').map(Number))
        if (!choices.length) continue
        ensure(
            choices.every(([id, reward]) => Number.isInteger(id) && id > 0 && Number.isInteger(reward) && reward >= 0),
            'Invalid dorm daily topic',
            1007,
        )
        // TODO: official topic-selection weights are not supplied; use a uniform
        // draw from this hero's configured stories, saved for the whole reset day.
        topics.heroes[actor.conf_id] ??= { story_id: choices[rng(choices.length)][0], complete: false }
        const selected = topics.heroes[actor.conf_id]
        if (!selected.complete) storys.push({ heor_id: actor.conf_id, story_id: selected.story_id })
    }
    return { storys }
}
export function claimDormTopic(tables, state, request, now) {
    dormTopics(tables, state, now)
    const visit = activeDormVisit(tables, state)
    ensure(visit || state.world.map_id === homeMapId(tables), 'Daily topic requires home or an active dorm visit')
    const actor = state.player.heros_info.heros.find((entry) => entry.conf_id === request?.heor_id)
    ensure(actor && (!visit || visit.hero_id === actor.guid), 'Daily topic belongs to another hero')
    const selected = state.home.dormTopics.heroes[actor.conf_id]
    ensure(selected?.story_id === request.story_id, 'Daily topic was not offered')
    if (selected.complete) return { storys: request, favorability: 0 }
    const row = dormSceneConfig(tables, actor)
    const choice = String(row.dailyStory)
        .split('|')
        .map((entry) => entry.split('#').map(Number))
        .find(([id]) => id === request.story_id)
    ensure(choice, 'Daily topic configuration missing', 1007)
    const reward = addHeroFavorability(tables, actor, choice[1])
    selected.complete = true
    return { storys: request, favorability: reward }
}
