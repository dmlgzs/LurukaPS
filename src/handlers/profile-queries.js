import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { abyssGlobalView } from '../abyss-global-view.js'
import { abyssTables } from '../abyss-catalog.js'
import { abyssDataSnapshot } from '../abyss-data.js'
import { grantRewards } from '../rewards.js'
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
    on('ReadHandbookGet', (c, r) => {
        // PlayableOpenLibraryBookTestNode requests source1 before opening the
        // page. Other legacy source meanings have not been established.
        ensure(r.get_type === 1, 'Unsupported reading acquisition source', ErrorCode.HandbookTypeLimit)
        ensure(
            Number.isSafeInteger(r.book_id) && r.book_id > 0 && tables.find('library_readings', r.book_id),
            'Reading configuration is missing',
            ErrorCode.HandbookConfNone,
        )
        const known = c.state.readingBooks?.[r.book_id]
        ensure(
            !known || (known.book_id === r.book_id && [0, 1].includes(known.book_state)),
            'Invalid saved reading record',
            ErrorCode.GameConfig,
        )
        // The normal type28 ledger preserves owned/read state on retries.
        // Game publishes ReadHandbookInfoSync before this null reply.
        grantRewards(tables, c.state, [{ itemtype: 28, itemid: r.book_id, itemnum: 1 }])
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
        if (r.clear_inherit_flag && c.state.abyss?.inheritNotify === true) c.state.abyss.inheritNotify = false
        const response = abyssGlobalView(tables, c.state, c.now)
        // The map's non-rotation branch reads cached mode records rather than
        // response.mode. Prime the registered 11450 consumer before its callback.
        // Local sync order; no completion, inherited star or reward is created.
        c.pushBefore('SCProtoAbyssData', abyssDataSnapshot(abyssTables(tables), c.state, c.now))
        return response
    })
}
