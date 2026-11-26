import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Current MultiCampaignBaseInfo.player_list is scene.InitMapMember with a
// TeamV2MemberData payload, rather than CBT3's flat member description.
export function currentMapMember(state, accountId) {
    const manager = state.player.group_mgrs.find((entry) => entry.type === 1)
    const formation = manager?.groups.find((entry) => entry.id === manager.cur_group)
    const heroes = (formation?.heros ?? [])
        .map((slot) => state.player.heros_info.heros.find((hero) => String(hero.guid) === String(slot.hero_id)))
        .filter(Boolean)
    ensure(
        Number.isSafeInteger(accountId) && accountId > 0 && heroes.length > 0,
        'Map member formation is unavailable',
        ErrorCode.GameConfig,
    )
    const control = heroes.find((hero) => String(hero.guid) === String(formation.control)) ?? heroes[0]
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
