import { abyssTables } from './abyss-catalog.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function abyssIntroPlan(external, run) {
    const tables = abyssTables(external),
        scene = tables.find('dungeon_scene', run.map_id),
        params = new Map()
    for (const part of String(scene?.intParam ?? '')
        .split('|')
        .filter(Boolean)) {
        const [key, value, ...extra] = part.split('#')
        ensure(
            !extra.length && !params.has(key) && Number.isSafeInteger(Number(value)),
            'Invalid abyss scene integer parameter',
            ErrorCode.GameConfig,
        )
        params.set(key, Number(value))
    }
    const stage = params.get('story_id_' + (run.wave_index + 1)) ?? 0
    if (!stage) return null
    const target = params.get('storyworldmapId_' + (run.wave_index + 1)) ?? 0
    ensure(stage > 0 && tables.find('story', stage), 'Abyss boss intro story is unavailable', ErrorCode.GameConfig)
    ensure(
        target > 0 && run.wave_objects.includes(target),
        'Abyss boss intro target is outside its wave',
        ErrorCode.GameConfig,
    )
    return { stage_id: stage, target_id: target }
}
export function beginAbyssIntro(c) {
    const run = c.state.abyssRun,
        plan = abyssIntroPlan(c.tables, run)
    if (!plan) return false
    run.intro = {
        ...plan,
        status: 'pending',
        part_index: run.part_index,
        wave_index: run.wave_index,
        instance_id: run.instance_id,
        elapsed_before: Math.max(0, c.now - run.real_start_time),
    }
    run.phase = 'intro'
    return true
}
export function publishAbyssIntro(c) {
    const run = c.state.abyssRun,
        intro = run?.intro
    if (!intro || intro.status !== 'pending' || run.map_id !== c.state.world.map_id) return false
    const connection = c.combatSessionId ?? c.connectionKey
    if (connection && intro.connection === connection) return false
    c.push('SCProtoAbyssBossIntro', { stage_id: intro.stage_id, target_id: intro.target_id })
    if (connection) intro.connection = connection
    return true
}
export function finishAbyssIntro(c, request) {
    const run = c.state.abyssRun,
        intro = run?.intro
    ensure(run && run.map_id === c.state.world.map_id, 'No current abyss intro', ErrorCode.AbyssNoChallengeList)
    ensure(
        intro &&
            intro.instance_id === run.instance_id &&
            intro.part_index === run.part_index &&
            intro.wave_index === run.wave_index &&
            intro.stage_id === request.stage_id,
        'Abyss intro completion does not match the issued scene story',
        ErrorCode.AbyssInvalidChallengeLevel,
    )
    if (intro.status === 'done') return {}
    ensure(
        run.phase === 'intro' && intro.status === 'pending',
        'Abyss intro is not pending',
        ErrorCode.AbyssInvalidChallengeLevel,
    )
    intro.status = 'done'
    run.phase = 'running'
    run.real_start_time = c.now - intro.elapsed_before
    return {}
}
