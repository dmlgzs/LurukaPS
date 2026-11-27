import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import {
    createCultRoster,
    cultRosterFingerprint as fingerprintFor,
    checkedCultPreparation as checked,
} from './cult-formation.js'
import { trialPayload } from './handlers/trial-groups.js'
import { heroModules, petModules } from './battle.js'
import { retireTrialActors } from './trial-actors.js'

const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
const savedGroup = (state) => state.player.group_mgrs.find((manager) => manager.type === 8)
const clone = (value) => structuredClone(value)
function source(c, activityId) {
    ensure(positive(activityId), 'Invalid cultivation trial query activity', ErrorCode.ActivityGrowUpInvalidParam)
    const { row, entry } = c.activityCatalog.require(c.state, c.now, activityId, [60])
    ensure(
        !row.guideTaskId || c.activityCatalog.taskDone(c.state, row.guideTaskId),
        'Complete cultivation guide first',
        ErrorCode.ActivityGrowUpCondLimit,
    )
    const config = c.activityCatalog.growup.config(row.systemId),
        g = entry.growup
    ensure(
        g && g.cur_starting_id > 0 && [1, 2, 3].includes(g.cur_stage) && g.cur_growup_trail_stage === g.cur_stage,
        'Cultivation examination day is not ready',
        ErrorCode.ActivityGrowUpInvalidStage,
    )
    ensure(
        c.state.world.map_id === config.sceneID &&
            !c.state.cultTrial &&
            !c.state.entrust?.run &&
            !c.state.storyCampaign &&
            !c.state.multiCampaign &&
            !c.state.abyssRun,
        'Cultivation examination preview scene is not active',
        ErrorCode.ActivityGrowUpInvalidStage,
    )
    ensure(
        /^[1-9]\d*$/.test(String(g.guid)) && BigInt(g.guid) <= 0xffffffffffffffffn,
        'Cultivation run identity is malformed',
        ErrorCode.GameConfig,
    )
    return { row, entry, config, g, fingerprint: fingerprintFor(c, row, config) }
}
export function cultTrialPreparationAttributes(tables, state) {
    const value = state.cultTrialPreparation
    if (!value) return []
    const heroes = value.heroes.map((hero) => heroModules(tables, state, hero))
    return [...heroes, ...value.pets.map((pet) => petModules(tables, state, pet, heroes))]
}
function publish(c) {
    c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
    c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [savedGroup(c.state)] })
    c.pushBefore('CSProtoHeroAttrInfoSync', { heros: cultTrialPreparationAttributes(c.tables, c.state) })
}
function remove(c, notify) {
    const old = checked(c, c.state.cultTrialPreparation)
    retireTrialActors(c.state, [...old.heroes, ...old.pets])
    c.state.player.group_mgrs = c.state.player.group_mgrs.filter((x) => x.type !== 8)
    if (old.previous_manager) c.state.player.group_mgrs.push(clone(old.previous_manager))
    delete c.state.cultTrialPreparation
    if (notify) {
        c.pushBefore('CSProtoTrialDatas', trialPayload(c.state))
        c.pushBefore('CSProtoSyncPlayerData', {
            group_mgrs: [old.previous_manager ?? { type: 8, cur_group: 0, src: 0, groups: [] }],
        })
    }
}
export function cultTrialPreparationDue(tables, catalog, state, now) {
    const old = state.cultTrialPreparation
    if (old === undefined) return false
    const row = catalog.rows.find((entry) => entry.id === old?.activity_id && entry.type === 60)
    const g = state.activities?.[old?.activity_id]?.growup
    const config = row && catalog.growup.config(row.systemId)
    return !(
        row &&
        catalog.active(row, state, now) &&
        state.world.map_id === config.sceneID &&
        String(g?.guid) === old?.run_guid &&
        g?.cur_starting_id > 0 &&
        g.cur_stage === old.stage &&
        g.cur_growup_trail_stage === old.stage &&
        !state.cultTrial &&
        !state.abyssRun &&
        !state.entrust?.run &&
        !state.storyCampaign &&
        !state.multiCampaign
    )
}
export function reconcileCultTrialPreparation(c, { notify = true } = {}) {
    const old = c.state.cultTrialPreparation
    if (old === undefined) return false
    checked(c, old)
    // Invalid stored structure remains a configuration error; ordinary scene,
    // run and examination transitions retire only this non-owned UI roster.
    const row = c.activityCatalog.rows.find((x) => x.id === old.activity_id && x.type === 60)
    const g = c.state.activities?.[old.activity_id]?.growup
    const config = row && c.activityCatalog.growup.config(row.systemId)
    if (
        row &&
        c.activityCatalog.active(row, c.state, c.now) &&
        c.state.world.map_id === config.sceneID &&
        String(g?.guid) === old.run_guid &&
        g?.cur_starting_id > 0 &&
        g.cur_stage === old.stage &&
        g.cur_growup_trail_stage === old.stage &&
        !c.state.cultTrial &&
        !c.state.abyssRun &&
        !c.state.entrust?.run &&
        !c.state.storyCampaign &&
        !c.state.multiCampaign
    ) {
        ensure(
            old.fingerprint === fingerprintFor(c, row, config),
            'Cultivation preview source changed during examination',
            ErrorCode.GameConfig,
        )
        return false
    }
    remove(c, notify)
    return true
}
export function getCultTrialGroup(c, request) {
    const { row, config, g, fingerprint } = source(c, request.u32)
    const existing = c.state.cultTrialPreparation
    if (existing !== undefined) {
        const old = checked(c, existing)
        if (old.activity_id === row.id && old.run_guid === String(g.guid) && old.stage === g.cur_growup_trail_stage) {
            ensure(
                old.fingerprint === fingerprint,
                'Cultivation preview source changed during examination',
                ErrorCode.GameConfig,
            )
            publish(c)
            return {}
        }
        remove(c, false)
    }
    const previous = savedGroup(c.state)
    const roster = createCultRoster(c.tables, c.activityCatalog, c.state, c.id, { activity_id: row.id })
    const group = {
        id: 1,
        group_name: Buffer.from('考核编队').toString('base64'),
        heros: roster.heroes.map((hero, index) => ({ hero_id: hero.guid, pet_id: roster.pets[index].guid })),
        control: roster.heroes.find((hero) => hero.conf_id === config.defaulthero)?.guid ?? roster.heroes[0].guid,
    }
    c.state.cultTrialPreparation = {
        version: 1,
        owner_id: c.id,
        activity_id: row.id,
        run_guid: String(g.guid),
        stage: g.cur_growup_trail_stage,
        fingerprint,
        previous_manager: previous ? clone(previous) : null,
        heroes: roster.heroes,
        pets: roster.pets,
    }
    c.state.player.group_mgrs = [
        ...c.state.player.group_mgrs.filter((x) => x.type !== 8),
        { type: 8, cur_group: 1, src: 0, groups: [group] },
    ]
    publish(c)
    return {}
}
