import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { cultivationScore } from './growup-score.js'
// CBT3 GlobalData.get_GetMaxSaveNum (06004f89) and IsValidSaveIndex
// (060050b3) define four numbered slots; cul.endless is a rating gate instead.
export const GROWUP_ARCHIVE_SLOT_MAX = 4
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
function archiveLedger(entry) {
    const ledger = (entry.growupArchive ??= {
        version: 1,
        archive: [],
        history_trail_stage: 0,
        endless_max_score: '0',
        endless_max_wave: 0,
        rank_permyriad_max: 0,
        trails: [],
    })
    ensure(
        ledger.version === 1 &&
            Array.isArray(ledger.archive) &&
            ledger.archive.length <= GROWUP_ARCHIVE_SLOT_MAX &&
            new Set(ledger.archive.map((x) => x.archive_id)).size === ledger.archive.length &&
            ledger.archive.every(
                (x) => uint(x.archive_id) && x.archive_id >= 1 && x.archive_id <= GROWUP_ARCHIVE_SLOT_MAX,
            ),
        'Invalid saved cultivation archives',
        ErrorCode.GameConfig,
    )
    return ledger
}
function wireActivity(row, ledger) {
    return {
        activity_id: row.id,
        history_trail_stage: ledger.history_trail_stage ?? 0,
        archive: structuredClone(ledger.archive).sort((a, b) => a.archive_id - b.archive_id),
        endless_max_score: String(ledger.endless_max_score ?? 0),
        endless_max_wave: ledger.endless_max_wave ?? 0,
        rank_permyriad_max: ledger.rank_permyriad_max ?? 0,
        trails: structuredClone(ledger.trails ?? []),
    }
}
export function growupArchiveSnapshot(catalog, state, selection) {
    const data = []
    for (const row of catalog.rows) {
        if (row.type !== 60 || (selection && !selection.includes(row.id))) continue
        const entry = state.activities?.[row.id]
        if (entry?.growupArchive) data.push(wireActivity(row, archiveLedger(entry)))
    }
    return { data, del_activitys: [] }
}
function skillSnapshot(tables, systemId, g) {
    const tree = g.skill_tree_data ?? { chains: [], unlocked_nodes: [] },
        nodes = new Map(
            tables
                .get('game_events_cul_skill_tree')
                .filter((x) => x.systemId === systemId)
                .map((x) => [x.skillnode, x]),
        )
    ensure(
        Array.isArray(tree.chains) &&
            Array.isArray(tree.unlocked_nodes) &&
            new Set(tree.unlocked_nodes).size === tree.unlocked_nodes.length &&
            tree.unlocked_nodes.every((id) => uint(id) && nodes.has(id)) &&
            tree.chains.every(
                (c) =>
                    uint(c.head_node_id) &&
                    nodes.has(c.head_node_id) &&
                    uint(c.cur_node_id) &&
                    (c.cur_node_id === 0 || nodes.has(c.cur_node_id)),
            ),
        'Invalid completed cultivation skill tree',
        ErrorCode.GameConfig,
    )
    return structuredClone(tree)
}
export function archiveGrowupData(c, r, catalog) {
    ensure(
        Number.isSafeInteger(r.archive_id) && r.archive_id >= 1 && r.archive_id <= GROWUP_ARCHIVE_SLOT_MAX,
        'Invalid cultivation archive slot',
        ErrorCode.ActivityArchiveParamError,
    )
    const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60])
    ensure(
        !row.guideTaskId || catalog.taskDone(c.state, row.guideTaskId),
        'Complete cultivation guide first',
        ErrorCode.ActivityGrowUpCondLimit,
    )
    const system = catalog.growup,
        g = system.ensure(entry, row.systemId),
        config = system.config(row.systemId)
    ensure(
        g.cur_starting_id > 0 && g.cur_stage === 4 && g.cur_growup_trail_stage === 4,
        'Cultivation result is not complete',
        ErrorCode.ActivityGrowUpInvalidStage,
    )
    ensure(
        r.starting_id === g.cur_starting_id,
        'Cultivation archive starting selection differs',
        ErrorCode.ActivityStartingNotEqual,
    )
    const finals = g.trails.filter((result) =>
        system.tables
            .get('game_events_cul_trial')
            .some((trial) => trial.systemId === row.systemId && trial.trialId === result.trail_id && trial.phase === 3),
    )
    ensure(
        finals.length === 1 && g.trails.length === 3,
        'Cultivation examinations are incomplete',
        ErrorCode.CultEndNotComplete,
    )
    const trial = system.tables
            .get('game_events_cul_trial')
            .find((x) => x.systemId === row.systemId && x.trialId === finals[0].trail_id),
        ending = system.tables
            .get('game_events_cul_end')
            .find((x) => x.systemId === row.systemId && x.trial === trial.trialId && x.endingId === trial.ending)
    ensure(ending, 'Cultivation ending configuration unavailable', ErrorCode.CultInvalidEndId)
    ensure(
        /^\d+$/.test(String(g.guid)) && BigInt(g.guid) > 0n && BigInt(g.guid) >> 32n === BigInt(c.id),
        'Invalid cultivation run identity',
        ErrorCode.GameConfig,
    )
    ensure(
        g.trails.every(
            (result) =>
                c.state.acceptedCultTrials?.[g.guid + ':' + result.trail_id] &&
                (!result.guid || result.guid === String(g.guid)),
        ) &&
            g.end_data.complete_end.some(
                (x) => x.id === ending.endingId && x.starting_ids?.includes(g.cur_starting_id),
            ),
        'Cultivation completion receipt is missing',
        ErrorCode.CultEndNotComplete,
    )
    ensure(
        g.growup_train_attr.every((x) => uint(x.attr_value) && x.attr_value <= config.maxAttr && uint(x.cur_node ?? 0)),
        'Invalid completed cultivation attribute',
        ErrorCode.GameConfig,
    )
    const score = cultivationScore(system, row.systemId, {
        attrs: g.growup_train_attr,
        chrs: g.assist_chars,
        trails: g.trails,
    })
    ensure(
        /^\d+$/.test(String(g.final_score)) && BigInt(g.final_score) === BigInt(score.total),
        'Completed cultivation score is inconsistent',
        ErrorCode.GameConfig,
    )
    const ranks = system.tables.get('game_events_cul_finalrecord').filter((x) => x.activityid === row.systemId)
    ensure(
        Number.isSafeInteger(config.endless) &&
            config.endless > 0 &&
            ranks.some((x) => x.rating === config.endless) &&
            ranks.every((x) => uint(x.rating) && uint(x.needScore)),
        'Cultivation archive rating configuration invalid',
        ErrorCode.ActivityInvalidGrowUpConf,
    )
    const rating = Math.max(
        0,
        ...ranks.filter((x) => BigInt(g.final_score) >= BigInt(x.needScore)).map((x) => x.rating),
    )
    ensure(
        rating >= config.endless,
        'Cultivation final score is below archive threshold',
        ErrorCode.ActivityTotalScoreLess,
    )
    const ledger = archiveLedger(entry),
        old = ledger.archive.find((x) => x.archive_id === r.archive_id)
    if (!old || old.guid !== String(g.guid)) {
        const saved = {
            archive_id: r.archive_id,
            skill_tree_data: skillSnapshot(system.tables, row.systemId, g),
            growup_train_attr: structuredClone(g.growup_train_attr),
            final_score: String(g.final_score),
            starting_id: g.cur_starting_id,
            archive_time: String(c.now),
            assist_chars: structuredClone(g.assist_chars),
            ending_id: ending.endingId,
            guid: String(g.guid),
        }
        ledger.archive = ledger.archive.filter((x) => x.archive_id !== r.archive_id)
        ledger.archive.push(saved)
    }
    // Snapshot the current actual run, never the ending book's merged best run.
    // The normal run, book, grade and archive_guid remain unchanged.
    c.pushBefore('CSProtoSyncArchiveGrowupData', growupArchiveSnapshot(catalog, c.state, [row.id]))
    return {}
}
