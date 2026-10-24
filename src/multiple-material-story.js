import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { weeklyDungeonPolicy } from './weekly-dungeons.js'
import { worldInteractionRange } from './world-interaction-range.js'
const caches = new WeakMap()
const fields = (text) =>
    Object.fromEntries(
        String(text ?? '')
            .split('|')
            .filter(Boolean)
            .map((t) => {
                const [key, ...rest] = t.split('#')
                return [key, rest.join('#')]
            }),
    )
export function materialStoryPlan(tables, run) {
    const weekly = run?.kind === 'weekly'
    if (run?.kind !== 'material' && !weekly) return null
    let cache = caches.get(tables)
    if (!cache) caches.set(tables, (cache = new Map()))
    const cacheKey = `${run.kind}:${run.map_id}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)
    const invalid = (message) => {
        ensure(!weekly, message, ErrorCode.GameConfig)
        cache.set(cacheKey, null)
        return null
    }
    const scene = tables.find('dungeon_scene', run.map_id),
        city = tables.find('world_city', run.map_id),
        bp = scene && tables.find('world_blueprint', scene.blueprintId)
    // Bounded compatibility: the shipped table keeps an older resource alias;
    // the single matching bundle and its port graph are recorded in evidence.
    if (
        city?.type !== 12 ||
        typeof bp?.path !== 'string' ||
        !bp.path.endsWith('/multiplayer_dungeon_common.asset') ||
        fields(scene.boolParam).isBossOnly !== 'true'
    ) {
        return invalid('Weekly boss blueprint configuration unavailable')
    }
    const p = fields(scene.intParam),
        storyId = Number(p.bossStoryID),
        bossId = Number(p.bossID),
        pointId = Number(p.bossTransferID)
    let triggerId = Number(p.bossTriggerID)
    const missingTrigger = weekly && p.bossTriggerID === undefined
    if (
        ![storyId, bossId, pointId].every((n) => Number.isInteger(n) && n > 0) ||
        (!missingTrigger && !(Number.isInteger(triggerId) && triggerId > 0))
    )
        return invalid('Weekly boss intro parameters unavailable')
    const rows = tables.get(`worldmap_${run.map_id}`),
        boss = rows.find((r) => r.id === bossId),
        point = tables.find('world_borthpos', pointId)
    if (!boss || point?.cityId !== run.map_id) return invalid('Weekly boss intro route unavailable')
    const stages = rows
        .flatMap((row) => {
            const t = String(row.expandParams ?? '')
                .split('|')
                .find((t) => t.toLowerCase().startsWith('autobattleindex#'))
            return t
                ? [
                      {
                          row,
                          index: Number(t.split('#')[1]),
                          type: tables.find('world_spawner', row.spawnerId)?.objectType,
                      },
                  ]
                : []
        })
        .sort((a, b) => a.index - b.index)
    let localTriggerSource
    if (missingTrigger) {
        ensure(
            typeof weeklyDungeonPolicy.intro?.enabled === 'boolean' &&
                weeklyDungeonPolicy.intro.missingBossTrigger === 'unique-initial-interaction-marker',
            'LOCAL weekly missing-trigger policy is invalid',
            ErrorCode.GameConfig,
        )
        ensure(
            weeklyDungeonPolicy.intro.enabled,
            'LOCAL weekly missing-trigger compatibility is disabled',
            ErrorCode.FunctionClosed,
        )
        const candidates = stages.filter((s) => s.index === 1 && s.type === 13)
        ensure(candidates.length === 1, 'Weekly initial interaction marker is ambiguous', ErrorCode.GameConfig)
        triggerId = candidates[0].row.id
        localTriggerSource = {
            mode: 'local-inferred',
            table: `worldmap_${run.map_id}`,
            row_id: triggerId,
            spawner_id: candidates[0].row.spawnerId,
            field: 'autoBattleIndex#1',
            policy: 'unique-initial-interaction-marker',
        }
    }
    const trigger = rows.find((r) => r.id === triggerId)
    if (!trigger) return invalid('Weekly boss trigger object unavailable')
    const triggerSpawner = tables.find('world_spawner', trigger.spawnerId),
        op = (String(trigger.interactOptions ?? '').trim() || String(triggerSpawner?.interactOps ?? ''))
            .split('|')
            .map(Number)
            .map((id) => tables.find('world_interact', id))
            .find(
                (r) =>
                    r?.interactAction === 75 ||
                    (weekly && triggerSpawner?.objectType === 13 && r?.interactAction === 10019),
            )
    if (
        stages.length !== 3 ||
        stages[0].type !== 13 ||
        stages[1].row.id !== bossId ||
        stages[1].type !== 50 ||
        stages[2].type !== 30 ||
        !op ||
        !(triggerSpawner?.objectType === 306 || (weekly && triggerSpawner?.objectType === 13))
    ) {
        return invalid('Weekly boss intro stage/interaction configuration invalid')
    }
    ensure(tables.find('story', storyId), 'Material intro story configuration unavailable', ErrorCode.StoryConfNotExist)
    ensure(
        Number.isFinite(op.interactRange) && op.interactRange > 0,
        'Material story interaction range invalid',
        ErrorCode.GameConfig,
    )
    const xyz = String(trigger.position).split('|').map(Number)
    ensure(
        xyz.length === 3 && xyz.every(Number.isFinite),
        'Material story trigger position invalid',
        ErrorCode.GameConfig,
    )
    const plan = {
        map_id: run.map_id,
        story_id: storyId,
        boss_id: bossId,
        trigger_id: triggerId,
        point_id: pointId,
        marker_id: stages[0].row.id,
        marker_index: stages[0].index,
        boss_index: stages[1].index,
        range: op.interactRange * 100,
        pos: { x: Math.round(xyz[0] * 100), y: Math.round(xyz[1] * 100), z: Math.round(xyz[2] * 100) },
        ...(localTriggerSource
            ? {
                  local_trigger_source: {
                      ...localTriggerSource,
                      interact_id: op.id,
                      interact_options_source: String(trigger.interactOptions || '').trim()
                          ? 'worldmap'
                          : 'world_spawner',
                      override_params: String(trigger.interactOptions || '').trim()
                          ? String(trigger.interactOverrideParams || '')
                          : '',
                  },
              }
            : {}),
    }
    cache.set(cacheKey, plan)
    return plan
}
export function materialStoryPending(run) {
    const s = run?.materialStory
    return (
        !!s &&
        s.instance_id === run.instance_id &&
        s.map_id === run.map_id &&
        ['await_trigger', 'playing'].includes(s.phase)
    )
}
export function prepareMaterialStory(c) {
    const run = c.state.entrust?.run,
        plan = materialStoryPlan(c.tables, run)
    if (
        !plan ||
        run.status !== 2 ||
        run.map_id !== c.state.world.map_id ||
        run.battle_start_time ||
        run.battle_complete
    )
        return false
    if (run.materialStory) return materialStoryPending(run)
    if (run.stage_index !== plan.marker_index) return false
    ensure(
        Number.isSafeInteger(run.instance_id) && run.instance_id > 0,
        'Invalid material story instance',
        ErrorCode.GameConfig,
    )
    run.materialStory = {
        ...plan,
        instance_id: run.instance_id,
        phase: 'await_trigger',
        player_id: c.id,
        participants: [c.id],
        prepared_at: c.now,
    }
    run.stage_index = plan.boss_index
    return true
}
export function beginMaterialStory(c, objectId) {
    const run = c.state.entrust?.run,
        plan = materialStoryPlan(c.tables, run)
    if (!plan || objectId !== plan.trigger_id || run.map_id !== c.state.world.map_id) return false
    if (run.materialStory?.phase === 'done' || run.battle_start_time) return false
    ensure(run.status === 2, 'Material story run is not active', ErrorCode.InvalidLogic)
    ensure(run.loading_complete_at, 'Material scene has not finished loading', ErrorCode.InvalidLogic)
    ensure(
        typeof c.combatSessionId === 'string' && c.combatSessionId.length > 0,
        'Material story connection missing',
        ErrorCode.GameConfig,
    )
    ensure(
        ['x', 'y', 'z'].every((key) => Number.isInteger(c.state.world.pos?.[key])),
        'Saved player position is invalid',
        ErrorCode.GameConfig,
    )
    const distance = ['x', 'y', 'z'].reduce((n, k) => n + (c.state.world.pos[k] - plan.pos[k]) ** 2, 0)
    ensure(
        distance <= worldInteractionRange(plan.range, { hud: true }) ** 2,
        'Material story trigger is too far away',
        ErrorCode.InvalidArgument,
    )
    ensure(prepareMaterialStory(c), 'Material story is not at its configured entrance', ErrorCode.InvalidLogic)
    const story = run.materialStory
    ensure(Array.isArray(story.participants), 'Saved story participant list is invalid', ErrorCode.GameConfig)
    ensure(
        story.player_id === c.id && story.participants.length === 1 && story.participants[0] === c.id,
        'Only the local participant is supported',
        ErrorCode.FunctionClosed,
    )
    if (story.phase === 'playing') return false
    ensure(
        Number.isInteger(c.now) && c.now > 0 && c.now <= 0xffffffff,
        'Material story clock cannot encode',
        ErrorCode.GameConfig,
    )
    story.phase = 'playing'
    story.started_at = c.now
    story.playback_started_at = c.now
    story.connection_key = c.combatSessionId
    Object.assign(c.state.world, c.tables.position(c.tables.find('world_borthpos', story.point_id)))
    return true
}
export function materialStoryStartPayload(story) {
    return { story_id: story.story_id, target_id: story.boss_id, start_time: story.playback_started_at }
}
export function replayMaterialStory(c) {
    const run = c.state.entrust?.run,
        s = run?.materialStory
    if (
        !materialStoryPending(run) ||
        s.phase !== 'playing' ||
        run.map_id !== c.state.world.map_id ||
        s.connection_key === c.combatSessionId
    )
        return false
    ensure(s.player_id === c.id, 'Material story participant mismatch', ErrorCode.InvalidLogic)
    ensure(
        Number.isInteger(c.now) && c.now > 0 && c.now <= 0xffffffff,
        'Material story clock cannot encode',
        ErrorCode.GameConfig,
    )
    // Local reconnect policy: replay this unfinished intro from its beginning.
    // Keep the original epoch and audit start; do not fast-forward hours offline.
    s.connection_key = c.combatSessionId
    s.playback_started_at = c.now
    s.replays = (s.replays ?? 0) + 1
    c.push('SCProtoPlayerStoryStart', materialStoryStartPayload(s))
    return true
}
export function finishMaterialStory(c, r) {
    const run = c.state.entrust?.run,
        s = run?.materialStory
    ensure(run && s && run.map_id === c.state.world.map_id, 'No active material story run', ErrorCode.DungeonNotIn)
    ensure(
        s.instance_id === run.instance_id && s.map_id === run.map_id && s.player_id === c.id,
        'Material story instance mismatch',
        ErrorCode.InvalidLogic,
    )
    ensure(Array.isArray(s.participants), 'Saved story participant list is invalid', ErrorCode.GameConfig)
    ensure(
        s.participants.length === 1 && s.participants[0] === c.id,
        'Multiplayer story barriers are not supported',
        ErrorCode.FunctionClosed,
    )
    ensure(
        Number.isInteger(r.story_id) && r.story_id === s.story_id,
        'Story does not match this material intro',
        ErrorCode.InvalidArgument,
    )
    ensure([1, 2].includes(r.op), 'Unknown story stop operation', ErrorCode.InvalidArgument)
    ensure(r.op === 1, 'Story skip requires the separate voting protocol', ErrorCode.FunctionClosed)
    if (s.phase === 'done') return false
    ensure(
        s.phase === 'playing' && s.connection_key === c.combatSessionId,
        'Story is not playing on this connection',
        ErrorCode.InvalidLogic,
    )
    ensure(
        run.stage_index === s.boss_index && !run.battle_start_time,
        'Material story boss stage changed',
        ErrorCode.InvalidLogic,
    )
    ensure(
        Number.isInteger(c.now) && c.now > 0 && c.now <= 0xffffffff,
        'Material story clock cannot encode',
        ErrorCode.GameConfig,
    )
    s.phase = 'done'
    s.finished_at = c.now
    run.battle_start_time = c.now
    run.real_start_time = c.now
    return true
}
export function applyMaterialStoryVisibility(run, row, record) {
    const s = run.materialStory
    if (!s || s.instance_id !== run.instance_id || s.map_id !== run.map_id) return false
    let active = record.active,
        complete = record.complete
    // StoryTempUnitProcess recreates inactive objects as temporary worldmapId0
    // units. Enemy groups need their real map sync component and identity.
    // Keep the cinematic target loaded; ownership/damage/time remain gated by END.
    if (row.id === s.boss_id && materialStoryPending(run)) active = run.stage_index === s.boss_index
    if (row.id === s.trigger_id) {
        active = s.phase === 'await_trigger'
        complete = s.phase !== 'await_trigger'
    }
    const changed = active !== record.active || complete !== record.complete
    if (changed) {
        record.active = active
        record.complete = complete
        record.state_data = { ...record.state_data, complete, step: complete ? 1 : 0 }
    }
    return changed
}
