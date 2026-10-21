import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { configTime } from '../shops.js'
const fields = { 1: 'characterStory', 2: 'characterVoice', 3: 'characterPlot' }
function charInfo(id, records) {
    return {
        hero_id: Number(id),
        infos: Object.entries(records).map(([type, ids]) => ({ type_id: Number(type), record_id: ids })),
    }
}
export function registerProfileQueries(on, tables, store) {
    on('ChangeShowPet', (c, r) => {
        // pageSelectPetDisplay saves all selected pets in four one-based slots.
        const selection = r.pet ?? []
        ensure(selection.length <= 4, 'Too many displayed pets')
        const positions = new Set(),
            guids = new Set()
        const shown = selection
            .map((entry) => {
                const guid = String(entry.pet_guid ?? '0')
                ensure(
                    Number.isInteger(entry.pos) &&
                        entry.pos >= 1 &&
                        entry.pos <= 4 &&
                        !positions.has(entry.pos) &&
                        !guids.has(guid),
                    'Duplicate or invalid displayed pet slot',
                )
                const pet = c.state.pets.find((row) => row.guid === guid)
                ensure(pet, 'Displayed pet is not owned', ErrorCode.PetNotExist)
                ensure(
                    tables.find('pet', pet.config_id),
                    'Displayed pet configuration missing',
                    ErrorCode.PetConfNotExist,
                )
                positions.add(entry.pos)
                guids.add(guid)
                return { guid, id: pet.config_id, lv: pet.lv, pos: entry.pos }
            })
            .sort((a, b) => a.pos - b.pos)
        const basic = c.state.player.basic_info
        basic.info = { ...basic.info, pet: shown }
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { info: basic.info } })
        return {}
    })
    on('ChangeShowHero', (c, r) => {
        // pageDisplayHero uses three one-based slots and sends the complete selection.
        const selection = r.hero ?? []
        ensure(selection.length <= 3, 'Too many displayed heroes')
        const positions = new Set(),
            guids = new Set()
        const shown = selection
            .map((entry) => {
                const guid = String(entry.hero_id ?? '0')
                ensure(
                    Number.isInteger(entry.pos) &&
                        entry.pos >= 1 &&
                        entry.pos <= 3 &&
                        !positions.has(entry.pos) &&
                        !guids.has(guid),
                    'Duplicate or invalid displayed hero slot',
                )
                const hero = c.state.player.heros_info.heros.find((row) => row.guid === guid)
                ensure(hero && !hero.trail, 'Displayed hero is not owned', ErrorCode.HeroNotExist)
                ensure(tables.find('hero', hero.conf_id), 'Displayed hero configuration missing', ErrorCode.GameConfig)
                positions.add(entry.pos)
                guids.add(guid)
                return {
                    id: guid,
                    config: hero.conf_id,
                    lv: hero.hero_lv,
                    pos: entry.pos,
                    star: hero.hero_star,
                    skin: hero.hero_skin ?? hero.conf_id,
                }
            })
            .sort((a, b) => a.pos - b.pos)
        const basic = c.state.player.basic_info
        basic.info = { ...basic.info, hero: shown }
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { info: basic.info } })
        return {}
    })
    on('ReadHandbookRead', (c, r) => {
        const ids = [...new Set(r.book_id ?? [])]
        ensure(ids.length <= 256, 'Too many readings')
        for (const id of ids) {
            ensure(c.state.readingBooks?.[id], 'Reading not owned')
            c.state.readingBooks[id].book_state = 1
        }
        return { book_id: ids }
    })
    on('ChangeShowcaseType', (c, r) => {
        const mode = r.u32 ?? 0
        ensure(mode === 0 || mode === 1, 'Invalid showcase type')
        c.state.player.basic_info.show_case = mode
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { show_case: mode } })
        return {}
    })
    on('CharDataUpdateHero', (c, r) => {
        ensure(
            c.state.player.heros_info.heros.some((h) => h.conf_id === r.hero_id),
            'Hero not owned',
        )
        const config = tables.find('char_data', r.hero_id),
            field = fields[r.type_id]
        ensure(config && field, 'Unknown hero data category')
        const ids = r.record_id ?? [],
            allowed = new Set(
                String(config[field] || '')
                    .split('|')
                    .filter(Boolean)
                    .map(Number),
            )
        ensure(ids.length <= 256 && ids.every((id) => allowed.has(id)), 'Record does not belong to hero/category')
        const records = (c.state.heroReadRecords ??= {}),
            hero = (records[r.hero_id] ??= {})
        hero[r.type_id] = [...new Set([...(hero[r.type_id] ?? []), ...ids])].sort((a, b) => a - b)
        return charInfo(r.hero_id, hero)
    })
    on('CharDataGetAll', (c) => ({
        heros_char_data: Object.entries(c.state.heroReadRecords ?? {}).map(([id, records]) => charInfo(id, records)),
    }))
    on('FriendRecommend', (c) => ({
        player_infos: store
            .publicProfiles(c.id, 20)
            .filter((p) => !(c.state.friends ?? []).includes(p.id) && !(c.state.blockedPlayers ?? []).includes(p.id)),
    }))
    on('AbyssGlobalView', (c, r) => {
        const state = (c.state.abyss ??= { cleared_levels: {}, inherit_notify_flag: false })
        const cleared = state.cleared_levels ?? {}
        const modes = tables.get('abbys_mode'),
            levels = (id) =>
                String(modes.find((m) => m.id === id)?.level || '')
                    .split('|')
                    .filter(Boolean)
                    .map(Number)
        const newer = levels(1),
            permanent = levels(2)
        ensure(newer.length && permanent.length, 'Missing abyss configuration', ErrorCode.GameConfig)
        let mode = newer.every((id) => cleared[id]?.completed) ? 2 : 1
        const rotation = tables
            .get('abbys_time')
            .find((row) => c.now >= configTime(row.startTime) && c.now < configTime(row.endTime))
        if (mode === 2 && permanent.every((id) => cleared[id]?.completed) && rotation) mode = 3
        const available = mode === 3 ? String(rotation.level).split('|').map(Number) : mode === 2 ? permanent : newer
        const progress = mode === 3 ? (state.rotations?.[rotation.id]?.levels ?? {}) : cleared
        if (r.clear_inherit_flag) state.inherit_notify_flag = false
        const stars = available.reduce(
            (n, id) => n + Math.max(0, Math.min(tables.find('abbys_level', id)?.star ?? 3, progress[id]?.stars ?? 0)),
            0,
        )
        return {
            rotation_id: rotation?.id ?? 0,
            rotation_mode_end_time: rotation ? configTime(rotation.endTime) : 0,
            cur_level: available.find((id) => !progress[id]?.completed) ?? available.at(-1),
            total_star: stars,
            inherit_notify_flag: !!state.inherit_notify_flag,
            mode,
        }
    })
}
