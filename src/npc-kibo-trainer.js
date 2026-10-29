import { invalidateTrackedHeroes } from './medicine-state.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { mainHeroConfigId } from './main-hero.js'
import { retireTrialActors, temporaryHeroes } from './trial-actors.js'

export function arenaTrainer(tables, state, duel, formation) {
    if (!duel.trialRole) {
        const hero = state.player.heros_info.heros.find((hero) => hero.guid === formation?.hero)
        ensure(hero, 'Arena hero not owned')
        return hero
    }
    const row = tables.find('hero_interim', duel.trialRole)
    ensure(row && row.level > 0, 'Arena trial trainer configuration unavailable', ErrorCode.GameConfig)
    ensure(
        !row.accessorySet && !row.talentrune,
        'Arena trial trainer equipment not implemented',
        ErrorCode.FunctionClosed,
    )
    const configId =
        row.heroType === 1 && [mainHeroConfigId(tables, 1), mainHeroConfigId(tables, 2)].includes(row.heroId)
            ? mainHeroConfigId(tables, state.player.basic_info.wardrobe?.sex ?? state.player.basic_info.sex)
            : row.heroId
    ensure(tables.find('hero', configId), 'Arena trial trainer hero unavailable', ErrorCode.HeroNotExist)
    // Match the existing CBT3 trial actor layout: type5, hero_interim ID,
    // account. Never downgrade or rename the player's owned copy.
    return {
        guid: ((5n << 56n) | (BigInt(row.id) << 32n) | BigInt(state.player.basic_info.id)).toString(),
        conf_id: configId,
        hero_lv: row.level,
        hero_exp: 0,
        hero_rank: row.rank,
        hero_star: row.starLevel,
        hero_grade: row.gradeLevel,
        system_skill_levels: String(row.skilllevel).split('|').map(Number),
        trail: true,
        type: row.heroType,
        wguid: 0,
        pet_id: '0',
        trial_pet: '0',
        favorability_lv: 1,
    }
}

export function prepareArenaTrainer(tables, state, duel, formation) {
    const hero = arenaTrainer(tables, state, duel, formation)
    if (duel.trialRole) {
        const prior = state.npcArenaTrialTrainer
        if (!prior || prior.duel_id !== duel.id || prior.map_id !== state.world.map_id || prior.hero.guid !== hero.guid)
            invalidateTrackedHeroes(
                state,
                [hero.guid, ...(prior ? [prior.hero.guid] : [])],
                'arena-trainer-registration',
            )
        state.npcArenaTrialTrainer = { duel_id: duel.id, map_id: state.world.map_id, hero }
    } else clearArenaTrialTrainer(state)
    return hero
}

export function clearArenaTrialTrainer(state) {
    const trial = state.npcArenaTrialTrainer
    if (!trial) return false
    delete state.npcArenaTrialTrainer
    retireTrialActors(state, [trial.hero])
    const remaining = new Set(temporaryHeroes(state).map((hero) => hero.guid))
    state.player.heros_info.battle_infos = state.player.heros_info.battle_infos.filter(
        (info) => info.hero_id !== trial.hero.guid || remaining.has(info.hero_id),
    )
    return true
}

export function expireArenaTrialTrainer(state) {
    const trial = state.npcArenaTrialTrainer
    return !!trial && (trial.map_id !== state.world.map_id || trial.duel_id !== state.multiCampaign?.duel_id)
        ? clearArenaTrialTrainer(state)
        : false
}
