import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { activeFormationManager, temporaryHeroes } from './trial-actors.js'

// Current MultiCampaignBaseInfo.player_list is scene.InitMapMember with a
// TeamV2MemberData payload, rather than CBT3's flat member description.
export function currentMapMember(state, accountId, options) {
    let heroes, control
    if (options !== undefined) {
        ensure(
            options &&
                typeof options === 'object' &&
                options.hero &&
                Object.keys(options).every((key) => key === 'hero'),
            'Map member hero override is invalid',
            ErrorCode.GameConfig,
        )
        const requested = options.hero,
            trial = state.npcArenaTrialTrainer,
            registered =
                state.player.heros_info.heros.find((hero) => hero.guid === requested.guid) ??
                (trial && trial.map_id === state.world.map_id && trial.duel_id === state.multiCampaign?.duel_id
                    ? trial.hero
                    : undefined)
        const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
        ensure(
            registered &&
                registered.guid === requested.guid &&
                registered.conf_id === requested.conf_id &&
                registered.hero_lv === requested.hero_lv &&
                (registered.hero_skin || registered.conf_id) === (requested.hero_skin || requested.conf_id) &&
                positive(registered.conf_id) &&
                positive(registered.hero_lv) &&
                positive(registered.hero_skin || registered.conf_id),
            'Map member arena hero source is unavailable or changed',
            ErrorCode.GameConfig,
        )
        heroes = [registered]
        control = registered
    } else {
        const manager = activeFormationManager(state),
            formation = manager?.groups.find((entry) => entry.id === manager.cur_group)
        ensure(
            formation && Array.isArray(formation.heros),
            'Map member active formation is unavailable',
            ErrorCode.GameConfig,
        )
        const available = [...state.player.heros_info.heros, ...temporaryHeroes(state)],
            selected = formation.heros.filter((slot) => slot.hero_id && String(slot.hero_id) !== '0'),
            ids = new Set()
        heroes = selected.map((slot) => {
            const id = String(slot.hero_id),
                matches = available.filter((hero) => String(hero.guid) === id)
            ensure(matches.length > 0, 'Map member active hero is unavailable', ErrorCode.HeroNotExist)
            ensure(
                matches.length === 1 && !ids.has(id),
                'Map member active hero identity is ambiguous or duplicated',
                ErrorCode.GameConfig,
            )
            ids.add(id)
            return matches[0]
        })
        control = heroes.find((hero) => String(hero.guid) === String(formation.control))
        ensure(control, 'Map member control is not an active formation hero', ErrorCode.GameConfig)
    }
    ensure(
        Number.isSafeInteger(accountId) && accountId > 0 && heroes.length > 0,
        'Map member formation is unavailable',
        ErrorCode.GameConfig,
    )
    return {
        pid: accountId,
        data: {
            name: Buffer.from(state.player.basic_info.name, 'base64').toString('utf8'),
            lv: state.player.basic_info.lv,
            ...(state.player.basic_info.wardrobe
                ? { wardrobe: structuredClone(state.player.basic_info.wardrobe) }
                : {}),
            ...(state.player.basic_info.clothes_info
                ? { clothes: structuredClone(state.player.basic_info.clothes_info) }
                : {}),
            group: {
                control_hero: control.conf_id,
                hero_list: heroes.map((hero) => ({
                    hero_id: hero.conf_id,
                    hero_level: hero.hero_lv,
                    hero_skin_id: hero.hero_skin || hero.conf_id,
                })),
            },
        },
    }
}
