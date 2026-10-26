import { recordCultRankResult } from './cult-rank-progress.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { GROWUP_ARCHIVE_SLOT_MAX } from './growup-archive.js'

// Each fight owns a deep copy. Saving/resetting a normal run, or overwriting a
// numbered archive while fighting, must not change actors or the score rate.
export function selectCultArchive(c, row, entry, request, trial) {
    ensure(
        Number.isInteger(request.archive_id) &&
            request.archive_id >= 1 &&
            request.archive_id <= GROWUP_ARCHIVE_SLOT_MAX,
        'Invalid cultivation archive slot',
        ErrorCode.ActivityArchiveParamError,
    )
    ensure(trial.phase === 4, 'A saved archive requires the endless trial', ErrorCode.ActivityGrowUpInvalidStage)
    const saved = entry.growupArchive?.archive?.find((x) => x.archive_id === request.archive_id)
    ensure(saved, 'Cultivation archive does not exist', ErrorCode.ActivityArchiveParamError)
    const config = c.activityCatalog.growup.config(row.systemId),
        attrs = c.activityCatalog.tables.get('game_events_cul_attr').filter((x) => x.systemId === row.systemId)
    ensure(
        /^\d+$/.test(String(saved.guid)) &&
            BigInt(saved.guid) > 0n &&
            BigInt(saved.guid) >> 32n === BigInt(c.id) &&
            Array.isArray(saved.growup_train_attr) &&
            saved.growup_train_attr.length === attrs.length &&
            new Set(saved.growup_train_attr.map((x) => x.attr_id)).size === attrs.length &&
            saved.growup_train_attr.every(
                (x) =>
                    attrs.some((a) => a.AttrId === x.attr_id) &&
                    Number.isSafeInteger(x.attr_value) &&
                    x.attr_value >= 0 &&
                    x.attr_value <= config.maxAttr,
            ),
        'Cultivation archive identity or attributes are damaged',
        ErrorCode.GameConfig,
    )
    ensure(
        c.activityCatalog.tables
            .get('game_events_cul_starting')
            .some((x) => x.systemId === row.systemId && x.startingId === saved.starting_id),
        'Saved cultivation starting configuration unavailable',
        ErrorCode.ActivityInvalidGrowUpConf,
    )
    return saved
}

export function cultArchiveLoadout(catalog, run, config) {
    if (!run.archive_id) return config
    const systemId = catalog.rows.find((x) => x.id === run.activity_id).systemId,
        ranks = catalog.tables.get('game_events_cul_attrRate').filter((x) => x.eventid === systemId),
        attrs = new Map(run.archive.growup_train_attr.map((x) => [x.attr_id, x.attr_value])),
        nodes = catalog.tables
            .get('game_events_cul_skill_tree')
            .filter((x) => x.systemId === systemId && x.herointerimid)
    const rank = (id) => Math.max(1, ...ranks.filter((r) => attrs.get(id) >= r.needAttr).map((r) => r.rating))
    // The client's formation UI evaluates 80009 against archived attributes
    // (060170b3 -> 0600501b -> 0600501d), independent of the live normal run.
    // These current template rows are one attribute's increasing tiers. Do not
    // choose by final score, or silently decide a future conflicting branch.
    const applicable = nodes
        .filter((node) =>
            String(node.condition)
                .split('|')
                .every((text) => {
                    const [kind, activity, attr, need, ...extra] = text.split('#').map(Number)
                    ensure(
                        kind === 80009 && activity === systemId && attrs.has(attr) && !extra.length,
                        'Unsupported cultivation archive loadout condition',
                        ErrorCode.FunctionClosed,
                    )
                    return rank(attr) >= need
                }),
        )
        .sort((a, b) => a.pos - b.pos)
    ensure(
        new Set(applicable.map((x) => x.attribute)).size <= 1,
        'Conflicting cultivation archive loadout branches',
        ErrorCode.FunctionClosed,
    )
    const selected = applicable.at(-1)
    return selected ? { ...config, herointerimid: selected.herointerimid, petinterimid: selected.petinterimid } : config
}

const scales = new WeakMap()
export function cultArchiveEnemyDefinition(tables, run, definition) {
    if (!run.archive_id || !definition) return definition
    let byDungeon = scales.get(tables)
    if (!byDungeon) scales.set(tables, (byDungeon = new Map()))
    let byObject = byDungeon.get(run.dungeon_id)
    if (!byObject) {
        byObject = new Map()
        // TDDungeon.GetWorldMap2AttScaleDict 060202a7: object ID followed
        // by (attribute, permyriad scale) pairs. Attribute 5 is max HP.
        for (const text of String(tables.find('dungeon', run.dungeon_id)?.difficultIndex ?? '')
            .split('|')
            .filter(Boolean)) {
            const [id, ...pairs] = text.split('#').map(Number)
            ensure(
                pairs.length && pairs.length % 2 === 0 && [id, ...pairs].every(Number.isSafeInteger),
                'Invalid cultivation dungeon attribute scale',
                ErrorCode.GameConfig,
            )
            const values = new Map()
            for (let i = 0; i < pairs.length; i += 2) values.set(pairs[i], pairs[i + 1])
            byObject.set(id, values)
        }
        byDungeon.set(run.dungeon_id, byObject)
    }
    const scale = byObject.get(definition.object_id)?.get(5) ?? 10000,
        max_hp = Math.floor((definition.max_hp * scale) / 10000)
    ensure(
        Number.isSafeInteger(max_hp) && max_hp > 0 && max_hp <= 0xffffffff,
        'Invalid cultivation dungeon HP scale',
        ErrorCode.GameConfig,
    )
    return { ...definition, max_hp }
}

export function recordCultArchiveResult(tables, state, now) {
    const run = state.cultTrial
    if (!run?.archive_id || !run.battle_complete || run.result_published) return false
    state.activities = { ...state.activities }
    const entry = (state.activities[run.activity_id] = { ...state.activities[run.activity_id] }),
        ledger = (entry.growupArchive = structuredClone(entry.growupArchive))
    ensure(ledger?.version === 1, 'Cultivation archive ledger unavailable', ErrorCode.GameConfig)
    // History contains real battle score only. The archive's raising score is
    // displayed separately by the client; no fake rating/rank is manufactured.
    const result = {
        trail_id: run.trial_id,
        star: 0,
        score: String(run.score ?? 0),
        rate: run.score_rate ?? 10000,
        guid: run.archive.guid,
    }
    const previous = ledger.trails.find((x) => x.trail_id === run.trial_id)
    if (!previous || BigInt(result.score) > BigInt(previous.score))
        ledger.trails = [...ledger.trails.filter((x) => x.trail_id !== run.trial_id), result]
    ledger.endless_max_score = String(
        BigInt(ledger.endless_max_score ?? '0') > BigInt(result.score) ? ledger.endless_max_score : result.score,
    )
    ledger.endless_max_wave = Math.max(ledger.endless_max_wave ?? 0, run.completed_waves ?? 0)
    recordCultRankResult(tables, state, run, now)
    run.result_published = true
    return true
}
