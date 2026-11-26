import { bytes } from './player.js'
import { starterProfileMode } from './starter-profile.js'

const isBlankGroup = (group) =>
    group.heros.every((slot) => !slot.hero_id || slot.hero_id === '0') && (!group.control || group.control === '0')

export function initializeCharacterFormation(tables, state) {
    // The seed already gives a fresh account one valid loading placeholder in
    // team1. Apply the player's choice only when the creation callback arrives;
    // do not rewrite saved formations during login.
    if (!state.characterCustomized) return false
    // Normal has one stable persona already bound by its trusted factory.
    // Preserve explicit pets/equipment/GM formations during appearance changes.
    if (starterProfileMode(state) === 'normal') return false
    const groups = state.player.group_mgrs.find((manager) => manager.type === 1)?.groups,
        group = groups?.find((candidate) => candidate.id === 1)
    if (!group) return false

    const game = tables.get('game'),
        key = state.player.basic_info.sex === 1 ? 'AVATAR_HERO_ID_MALE' : 'AVATAR_HERO_ID_FEMALE',
        id = Number(game.find((row) => row.title === key)?.value),
        main = state.player.heros_info.heros.find((hero) => hero.conf_id === id),
        placeholder = state.player.heros_info.heros[0]?.guid
    if (!main) throw Error('Configured protagonist is not available')
    if (!placeholder) throw Error('Starter placeholder hero is not available')

    const isPlaceholderParty =
        group.heros.length === 3 &&
        group.heros[0].hero_id === placeholder &&
        group.heros.slice(1).every((slot) => !slot.hero_id || slot.hero_id === '0') &&
        group.control === placeholder
    const isMainParty =
        group.heros.length === 3 &&
        group.heros[0].hero_id === main.guid &&
        group.heros.slice(1).every((slot) => !slot.hero_id || slot.hero_id === '0') &&
        group.control === main.guid
    let changed = false
    if (isBlankGroup(group) || isPlaceholderParty) {
        group.heros = Array.from({ length: 3 }, (_, i) => ({
            hero_id: i === 0 ? main.guid : '0',
            pet_id: '0',
        }))
        group.control = main.guid
        changed = true
    } else if (!isMainParty) {
        return false
    }
    return restoreCompanion(state, main, groups) || changed
}

function restoreCompanion(state, main, groups) {
    if (
        !(state.tasks ?? []).some((task) => [106001, 106002].includes(task.task_id)) ||
        (main.pet_id && main.pet_id !== '0')
    )
        return false
    const old = state.player.heros_info.heros[0],
        pet = state.pets.find((candidate) => candidate.guid === old.pet_id && candidate.hero_id === old.guid)
    if (
        !pet ||
        old.guid === main.guid ||
        groups
            .filter((candidate) => candidate.id !== 0)
            .some((candidate) => candidate.heros.some((slot) => slot.hero_id === old.guid))
    )
        return false
    old.pet_id = '0'
    main.pet_id = pet.guid
    pet.hero_id = main.guid
    for (const candidate of groups)
        for (const slot of candidate.heros)
            if (slot.hero_id === main.guid && (!slot.pet_id || slot.pet_id === '0')) slot.pet_id = pet.guid
    return true
}

// CBT3 L_PlayerStore:getIsNewPlayer uses the first character of the decoded
// player name. Legacy placeholder names omitted the required '&' prefix.
export function repairCharacterCreationMarker(state) {
    if (
        state.characterCustomized ||
        ![bytes('AzurPlayer'), bytes('&AzurJSPlayer')].includes(state.player.basic_info.name)
    )
        return false
    if (!(state.tasks ?? []).some((task) => task.task_id === 106001)) return false
    state.player.basic_info.name = bytes('&AzurPlayer')
    return true
}
