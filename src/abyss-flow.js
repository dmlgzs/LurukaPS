import { requireAbyssRun, abyssTaskTags } from './abyss-battle.js'
import { abyssTables, abyssRoute } from './abyss-catalog.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
export function nextAbyssRoom(c) {
    const run = requireAbyssRun(c)
    if (run.phase === 'ready' && run.last_transition === 'next') return run
    ensure(
        run.phase === 'won' && run.challenges[run.part_index]?.win,
        'Current abyss room is not won',
        ErrorCode.AbyssInvalidChallengeLevel,
    )
    const next = run.rooms[run.part_index + 1]
    ensure(next, 'Abyss challenge has no next room', ErrorCode.AbyssInvalidChallengeLevel)
    const { route, point } = abyssRoute(abyssTables(c.tables), next.dungeon_id)
    ensure(route.map_id === next.map_id, 'Saved abyss room mapping changed', ErrorCode.InstanceSceneConfNotExist)
    run.part_index++
    run.map_id = next.map_id
    run.dungeon_id = next.dungeon_id
    run.phase = 'ready'
    run.retry = false
    run.last_transition = 'next'
    for (const key of [
        'wave_index',
        'wave_objects',
        'completed_objects',
        'scene_objects',
        'real_start_time',
        'end_time',
        'initialized_map',
    ])
        delete run[key]
    run.task_tags = abyssTaskTags(c.tables, run, c.now)
    Object.assign(c.state.world, abyssTables(c.tables).position(point))
    return run
}
