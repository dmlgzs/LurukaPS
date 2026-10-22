import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petData } from './pets.js'
import { mainHeroConfigId } from './main-hero.js'
import { pairs, syncBattle } from './battle.js'
import { trialPayload } from './handlers/trial-groups.js'
import { retireTrialActors } from './trial-actors.js'
import { cultArchiveLoadout } from './cult-archive-trial.js'
import { trialSoulEssence, trialOrnaments, trialRuneIds } from './trial-equipment.js'
import { rememberCultActivityAttrReset } from './cult-activity-attributes.js'
const list = (value) =>
    String(value || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function ensureCultFormation(tables, catalog, state, accountId) {
    const run = state.cultTrial
    if (!run || state.world.map_id !== run.map_id) return false
    const existing = state.player.group_mgrs.find((x) => x.type === 8),
        active = existing?.groups.find((x) => x.id === existing.cur_group)
    if (
        run.heroes?.length === 3 &&
        run.pets?.length === 3 &&
        active?.heros.length === 3 &&
        active.heros.every(
            (slot) =>
                run.heroes.some((x) => x.guid === slot.hero_id) &&
                run.pets.some((x) => x.guid === slot.pet_id && x.hero_id === slot.hero_id),
        )
    )
        return false
    const config = cultArchiveLoadout(
        catalog,
        run,
        catalog.growup.config(catalog.rows.find((x) => x.id === run.activity_id).systemId),
    )
    const heroIds = list(config.herointerimid),
        petIds = list(config.petinterimid)
    ensure(
        heroIds.length === 3 && petIds.length === heroIds.length,
        'Invalid cultivation formation table',
        ErrorCode.GameConfig,
    )
    const heroes = heroIds.map((id) => {
        const cfg = catalog.tables.find('hero_interim', id)
        ensure(
            cfg && tables.find('hero', cfg.heroId),
            'Cultivation interim equipment is unavailable',
            ErrorCode.GameConfig,
        )
        trialSoulEssence(tables, cfg)
        trialOrnaments(tables, cfg)
        return {
            guid: ((5n << 56n) | (BigInt(id) << 32n) | BigInt(accountId)).toString(),
            conf_id: cfg.heroType === 1 ? mainHeroConfigId(tables, state.player.basic_info.sex) : cfg.heroId,
            hero_lv: cfg.level,
            hero_exp: 0,
            hero_rank: cfg.rank,
            rune_ids: trialRuneIds(
                tables,
                cfg,
                cfg.heroType === 1 ? mainHeroConfigId(tables, state.player.basic_info.sex) : cfg.heroId,
            ),
            hero_star: cfg.starLevel,
            hero_grade: cfg.gradeLevel,
            system_skill_levels: list(cfg.skilllevel),
            trail: true,
            type: cfg.heroType,
            wguid: 0,
            pet_id: '0',
            favorability_lv: 1,
        }
    })
    const pets = petIds.map((id, index) => {
        const cfg = catalog.tables.find('pet_interim', id)
        ensure(cfg && tables.find('pet', cfg.petId), 'Unknown cultivation interim pet', ErrorCode.PetConfNotExist)
        const guid = ((9n << 56n) | (BigInt(id) << 32n) | BigInt(accountId)).toString(),
            pet = petData(tables, cfg.petId, guid, 0)
        pet.type = 2
        pet.lv = cfg.petLevel
        pet.feature = cfg.feature || 1
        if (cfg.speed) pet.speed = cfg.speed
        pet.hero_id = heroes[index].guid
        pet.comprehension = [...pairs(cfg.param)].map(([attr_id, value]) => ({
            attr_id,
            value,
            level: 1,
            init_level: 1,
            cur_exp: 0,
        }))
        const skills = new Map(pet.inherent_skills.map((x) => [x.skill_slot, x]))
        if (cfg.signatureSkillList)
            skills.set(206, { skill_slot: 206, skill_id: cfg.signatureSkillList, skill_lv: 1, type: 0 })
        list(cfg.skillList).forEach((skill_id, i) =>
            skills.set(i + 1, { skill_slot: i + 1, skill_id, skill_lv: 1, type: 0 }),
        )
        for (const text of [cfg.fPropertyskillList, cfg.breakskillList])
            for (const [skill_slot, skill_id] of pairs(text))
                skills.set(skill_slot, { skill_slot, skill_id, skill_lv: 1, type: 0 })
        pet.inherent_skills = [...skills.values()]
        heroes[index].pet_id = guid
        return pet
    })
    if (!Object.hasOwn(run, 'previous_cult_manager'))
        run.previous_cult_manager = existing ? structuredClone(existing) : null
    run.heroes = heroes
    run.pets = pets
    state.player.group_mgrs = state.player.group_mgrs.filter((x) => x.type !== 8)
    state.player.group_mgrs.push({
        type: 8,
        cur_group: 1,
        src: 0,
        groups: [
            {
                id: 1,
                group_name: Buffer.from('考核编队').toString('base64'),
                heros: heroes.map((x, i) => ({ hero_id: x.guid, pet_id: pets[i].guid })),
                control: heroes[0].guid,
            },
        ],
    })
    return true
}
export function clearCultFormation(state) {
    const run = state.cultTrial
    if (!run) return null
    rememberCultActivityAttrReset(state)
    retireTrialActors(state, [...(run.heroes ?? []), ...(run.pets ?? [])])
    const ids = new Set((run.heroes ?? []).map((x) => x.guid))
    state.player.heros_info.battle_infos = state.player.heros_info.battle_infos.filter((x) => !ids.has(x.hero_id))
    state.player.group_mgrs = state.player.group_mgrs.filter((x) => x.type !== 8)
    if (run.previous_cult_manager) state.player.group_mgrs.push(run.previous_cult_manager)
    return run.previous_cult_manager ?? { type: 8, cur_group: 0, src: 0, groups: [] }
}
export function publishCultFormation(c) {
    syncBattle({ ...c, push: c.pushBefore })
    c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
    c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [c.state.player.group_mgrs.find((x) => x.type === 8)] })
}
