import { commitPermanentEnding } from './growup-permanent.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { growupArchiveSnapshot } from './growup-archive.js'

export function sweepCultTrial(c, r, catalog) {
    ensure(!r.archive_id, 'Archived endless cultivation cannot be swept', ErrorCode.CultTrailCannotSweep)
    const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60]),
        system = catalog.growup,
        g = system.ensure(entry, row.systemId),
        trial = catalog.tables
            .get('game_events_cul_trial')
            .find((x) => x.systemId === row.systemId && x.trialId === r.trial_id)
    ensure(
        trial && [1, 2, 3].includes(trial.phase),
        'This cultivation trial cannot be swept',
        ErrorCode.CultTrailCannotSweep,
    )
    ensure(
        !row.guideTaskId || catalog.taskDone(c.state, row.guideTaskId),
        'Complete cultivation guide first',
        ErrorCode.ActivityGrowUpCondLimit,
    )
    const receipt = g.guid + ':' + trial.trialId
    if (c.state.acceptedCultTrials?.[receipt] && g.cur_starting_id > 0) return {}
    ensure(
        g.cur_starting_id > 0 && g.cur_stage === trial.phase && g.cur_growup_trail_stage === trial.phase,
        'Cultivation sweep does not match the current examination',
        ErrorCode.CultTrailStageNotEqual,
    )
    ensure(g.select_trail_id > 0, 'Select a cultivation examination first', ErrorCode.CultTrailNotSelectTrial)
    ensure(
        g.select_trail_id === trial.trialId,
        'Cultivation examination selection differs',
        ErrorCode.CultTrailSelectTrialNotEqual,
    )
    ensure(system.condition(trial.condition, g), 'Cultivation examination is locked', ErrorCode.CultTrailNotUnlock)
    ensure(
        !c.state.cultTrial && !c.state.storyCampaign && !c.state.entrust?.run && !c.state.multiCampaign,
        'Finish the active dungeon before sweeping cultivation',
        ErrorCode.CultTrailCannotSweep,
    )
    const history = entry.growupArchive?.trails?.find((x) => x.trail_id === trial.trialId)
    ensure(history?.star >= 3, 'Cultivation trial has no three-star battle history', ErrorCode.CultTrailNotReachSweep)
    const total = g.growup_train_attr.reduce((n, x) => n + x.attr_value, 0),
        ranks = catalog.tables.get('game_events_cul_rank'),
        rank = Math.max(1, ...ranks.filter((x) => total >= x.needTotalAttr).map((x) => x.rank)),
        coefficient = ranks.filter((x) => total > x.needTotalAttr).at(-1)?.coefficient ?? ranks[0]?.coefficient
    ensure(
        rank >= trial.rankLevel,
        'Cultivation attributes have not reached sweep rank',
        ErrorCode.CultTrailNotReachSweep,
    )
    const skips = String(trial.skipScore).split('|').map(Number),
        effectId = Number(String(trial.effect1).split('|')[2]),
        effect = catalog.tables.get('game_events_cul_effect').find((x) => x.Id === effectId),
        bonus = Number(String(trial.finalscore).split('|')[2])
    ensure(
        skips.length >= 3 &&
            Number.isSafeInteger(skips[2]) &&
            skips[2] >= 0 &&
            effect?.type === 3 &&
            Number.isSafeInteger(bonus) &&
            bonus >= 0,
        'Cultivation sweep settlement configuration unavailable',
        ErrorCode.ActivityInvalidGrowUpConf,
    )
    const changes = String(effect.param)
        .split('|')
        .map((text) => {
            const [attr_id, value, source, ...extra] = text.split('#').map(Number),
                attr = g.growup_train_attr.find((x) => x.attr_id === attr_id)
            ensure(
                !extra.length && source === 3 && attr && Number.isSafeInteger(value) && value >= 0,
                'Cultivation sweep attribute configuration unavailable',
                ErrorCode.ActivityInvalidGrowUpConf,
            )
            return {
                attr_id,
                attr_value: Math.min(system.config(row.systemId).maxAttr, attr.attr_value + value) - attr.attr_value,
            }
        })
    for (const change of changes)
        g.growup_train_attr.find((x) => x.attr_id === change.attr_id).attr_value += change.attr_value
    // 06005073 uses the table's third skipScore and a three-star UI result.
    // This is a configured sweep result, never a new live battle record.
    ensure(
        Number.isSafeInteger(coefficient) && coefficient > 0,
        'Cultivation score coefficient unavailable',
        ErrorCode.ActivityInvalidGrowUpConf,
    )
    g.trails[trial.phase - 1] = {
        trail_id: trial.trialId,
        star: 3,
        score: String(skips[2]),
        rate: coefficient,
        guid: g.guid,
    }
    g.final_score = String(BigInt(g.final_score ?? '0') + BigInt(bonus))
    c.state.acceptedCultTrials = { ...c.state.acceptedCultTrials, [receipt]: true }
    if (trial.phase === 3) {
        const completed = system.finish(g, row.systemId, trial)
        commitPermanentEnding(c, catalog, row, entry, completed, 'sweep-completion')
    } else {
        g.cur_stage++
        g.action_count = 0
        g.cur_cost_expedition_count = system.config(row.systemId).expeditionCount
        system.prepare(entry, row.systemId, c.randomInt)
    }
    c.pushBefore('CSProtoActivityGrowUpAttrChangeSync', {
        activity_id: row.id,
        change_type: 3,
        growup_attr_change: changes,
    })
    catalog.notify(c, true)
    c.pushBefore('CSProtoSyncArchiveGrowupData', growupArchiveSnapshot(catalog, c.state, [row.id]))
    return {}
}
