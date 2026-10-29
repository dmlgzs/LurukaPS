import { observeAcceptedHeroVitals, invalidateTrackedHeroes, invalidateMedicineContext } from './medicine-state.js'
import { heroModules, heroBattleLimits, petModules } from './battle.js'
import { combatState } from './combat-state.js'
import { group } from './handlers/common.js'

// TranspointRecoverAction checks each formation hero and its attached pet.
// PAB_NEAR_TRANS_POINT also appears in task actions, so it carries no point ID
// and must not be interpreted as a request to change the player's position.
export function recoverFormationHp(c) {
    const ids = new Set(
        group(c.state)
            .heros.map((slot) => slot.hero_id)
            .filter((id) => id && id !== '0'),
    )
    const heroes = [...c.state.player.heros_info.heros, ...(c.state.trialGroup?.heroes ?? [])].filter((hero) =>
        ids.has(hero.guid),
    )
    const modules = heroes.map((hero) => heroModules(c.tables, c.state, hero))
    const infos = []
    const savedHeroes = c.state.player.heros_info.battle_infos
    for (let index = 0; index < heroes.length; index++) {
        const hero = heroes[index],
            max = heroBattleLimits(modules[index])
        let saved = savedHeroes.find((info) => info.hero_id === hero.guid)
        if (!saved) {
            saved = { hero_id: hero.guid, sp: max.sp }
            savedHeroes.push(saved)
        }
        saved.hp = max.hp
        saved.alive_state = 0
        observeAcceptedHeroVitals(c.state, hero.guid, saved, 'accepted-9102-recovery', c.now)
        infos.push({ uuid: hero.guid, hp: saved.hp, alive_state: 0, reason: 1 })
    }
    const pets = [...c.state.pets, ...(c.state.trialGroup?.pets ?? [])].filter(
        (pet) => ids.has(pet.hero_id) && c.tables.find('template_value', pet.config_id),
    )
    if (pets.length) {
        const battle = combatState(c.state, c.now)
        for (const pet of pets) {
            const max = heroBattleLimits(petModules(c.tables, c.state, pet, modules))
            battle.entities[pet.guid] = {
                ...battle.entities[pet.guid],
                uuid: pet.guid,
                hp: max.hp,
                max_hp: max.hp,
                alive_state: 0,
                updated_at: c.now,
            }
            infos.push({ uuid: pet.guid, hp: max.hp, alive_state: 0, reason: 1 })
        }
    }
    if (infos.length) c.pushBefore('CSProtoObjBattleInfoSync', { infos })
    return infos
}
