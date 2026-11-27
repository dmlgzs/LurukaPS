import { createHash } from 'node:crypto'
import { invalidateMedicineContext } from './medicine-state.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { hydrateTrialPet } from './trial-pet-hydration.js'
import { mainHeroConfigId } from './main-hero.js'
import { syncBattle } from './battle.js'
import { trialPayload } from './handlers/trial-groups.js'
import { retireTrialActors } from './trial-actors.js'
import { cultArchiveLoadout } from './cult-archive-trial.js'
import { trialSoulEssence, trialOrnaments, trialRuneIds } from './trial-equipment.js'
import { rememberCultActivityAttrReset } from './cult-activity-attributes.js'
const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
const savedGroup = (state) => state.player.group_mgrs.find((manager) => manager.type === 8)
const list = (value) =>
    String(value || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function cultRosterFingerprint(c, row, config) {
    const heroIds = String(config.herointerimid).split('|').map(Number),
        petIds = String(config.petinterimid).split('|').map(Number)
    const binding = {
        activityId: row.id,
        systemId: row.systemId,
        sceneId: config.sceneID,
        heroes: heroIds.map((id) => c.tables.find('hero_interim', id)),
        pets: petIds.map((id) => c.tables.find('pet_customized', id)),
        sex: c.state.player.basic_info.sex,
    }
    return createHash('sha256').update(JSON.stringify(binding)).digest('hex')
}
export function checkedCultPreparation(c, value) {
    ensure(
        value &&
            value.version === 1 &&
            value.owner_id === c.id &&
            positive(value.activity_id) &&
            typeof value.run_guid === 'string' &&
            /^[1-9]\d*$/.test(value.run_guid) &&
            [1, 2, 3].includes(value.stage) &&
            /^[0-9a-f]{64}$/.test(value.fingerprint) &&
            Array.isArray(value.heroes) &&
            value.heroes.length === 3 &&
            Array.isArray(value.pets) &&
            value.pets.length === 3 &&
            Object.hasOwn(value, 'previous_manager'),
        'Invalid cultivation trial preview identity',
        ErrorCode.GameConfig,
    )
    const configRow = c.activityCatalog.rows.find((row) => row.id === value.activity_id && row.type === 60)
    ensure(configRow, 'Cultivation preview activity configuration is missing', ErrorCode.GameConfig)
    const config = c.activityCatalog.growup.config(configRow.systemId)
    ensure(
        value.fingerprint === cultRosterFingerprint(c, configRow, config),
        'Cultivation preview source changed during examination',
        ErrorCode.GameConfig,
    )
    const heroTemplates = new Set(String(config.herointerimid).split('|').map(Number))
    const petTemplates = new Set(String(config.petinterimid).split('|').map(Number))
    const actor = (guid, kind, templates) => {
        if (typeof guid !== 'string' || !/^[1-9]\d*$/.test(guid)) return false
        const bits = BigInt(guid)
        return (
            bits <= 0xffffffffffffffffn &&
            Number(bits >> 56n) === kind &&
            Number(bits & 0xffffffffn) === c.id &&
            templates.has(Number((bits >> 32n) & 0xffffffn))
        )
    }
    ensure(
        value.heroes.every((hero) => actor(hero.guid, 5, heroTemplates) && hero.trail === true) &&
            value.pets.every(
                (pet) =>
                    actor(pet.guid, 9, petTemplates) &&
                    pet.type === 2 &&
                    pet.customized_id === Number((BigInt(pet.guid) >> 32n) & 0xffffffn),
            ) &&
            (value.previous_manager === null ||
                (value.previous_manager?.type === 8 && Array.isArray(value.previous_manager.groups))),
        'Cultivation preview actor identity is invalid',
        ErrorCode.GameConfig,
    )
    const manager = savedGroup(c.state),
        group = manager?.groups.find((x) => x.id === manager.cur_group)
    const heroes = new Set(value.heroes.map((x) => x.guid)),
        pets = new Set(value.pets.map((x) => x.guid))
    ensure(
        heroes.size === 3 &&
            pets.size === 3 &&
            group?.heros.length === 3 &&
            new Set(group.heros.map((x) => x.hero_id)).size === 3 &&
            new Set(group.heros.map((x) => x.pet_id)).size === 3 &&
            group.heros.every((x) => heroes.has(x.hero_id) && pets.has(x.pet_id)) &&
            heroes.has(group.control),
        'Cultivation preview formation references are invalid',
        ErrorCode.GameConfig,
    )
    return value
}
export function createCultRoster(tables, catalog, state, accountId, run) {
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
        const guid = ((9n << 56n) | (BigInt(id) << 32n) | BigInt(accountId)).toString()
        const pet = hydrateTrialPet(tables, id, guid)
        pet.hero_id = heroes[index].guid
        heroes[index].pet_id = guid
        return pet
    })
    return { heroes, pets }
}
export function ensureCultFormation(tables, catalog, state, accountId) {
    const run = state.cultTrial
    if (!run || state.world.map_id !== run.map_id) return false
    const existing = state.player.group_mgrs.find((x) => x.type === 8),
        active = existing?.groups.find((x) => x.id === existing.cur_group)
    if (
        state.cultTrialPreparation === undefined &&
        run.heroes?.length === 3 &&
        run.pets?.length === 3 &&
        run.pets.every((pet) => pet.customized_id === Number((BigInt(pet.guid) >> 32n) & 0xffffffn)) &&
        active?.heros.length === 3 &&
        active.heros.every(
            (slot) =>
                run.heroes.some((x) => x.guid === slot.hero_id) &&
                run.pets.some((x) => x.guid === slot.pet_id && x.hero_id === slot.hero_id),
        )
    )
        return false
    const prepared =
        state.cultTrialPreparation === undefined
            ? undefined
            : checkedCultPreparation(
                  { tables, activityCatalog: catalog, state, id: accountId },
                  state.cultTrialPreparation,
              )
    const g = state.activities?.[run.activity_id]?.growup
    const adopt =
        !run.archive_id &&
        prepared?.version === 1 &&
        prepared.activity_id === run.activity_id &&
        prepared.run_guid === String(g?.guid) &&
        prepared.stage === g?.cur_growup_trail_stage
    const { heroes, pets } = adopt
        ? { heroes: structuredClone(prepared.heroes), pets: structuredClone(prepared.pets) }
        : createCultRoster(tables, catalog, state, accountId, run)
    if (adopt) {
        invalidateMedicineContext(state, 'cult-roster-install')
        run.previous_cult_manager = structuredClone(prepared.previous_manager)
        run.heroes = heroes
        run.pets = pets
        delete state.cultTrialPreparation
        return true
    }
    if (prepared) {
        run.previous_cult_manager = structuredClone(prepared.previous_manager)
        retireTrialActors(state, [...prepared.heroes, ...prepared.pets])
        delete state.cultTrialPreparation
    }
    if (!Object.hasOwn(run, 'previous_cult_manager'))
        run.previous_cult_manager = existing ? structuredClone(existing) : null
    invalidateMedicineContext(state, 'cult-roster-install')
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
    c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
    c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [c.state.player.group_mgrs.find((x) => x.type === 8)] })
    syncBattle({ ...c, push: c.pushBefore })
}
