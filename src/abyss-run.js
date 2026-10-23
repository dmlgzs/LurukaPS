import { abyssTables, abyssModeLevels, abyssRoute } from './abyss-catalog.js'
import { abyssChallengeRoster } from './abyss-roster.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
export function abyssLevelRecord(state, mode, id, rotationId = 0) {
    return mode === 3
        ? state.abyss?.rotation?.id === rotationId
            ? state.abyss.rotation.levels?.[id]
            : null
        : state.abyss?.modes?.[mode]?.levels?.[id]
}
function hasPassed(tables, state, id, rotation) {
    const level = tables.find('abbys_level', id)
    return level && abyssLevelRecord(state, level.mode, id, rotation?.id)?.passed === true
}
function condition(tables, state, rule, rotation) {
    if (!rule) return true
    return String(rule)
        .split('|')
        .every((text) => {
            const [kind, id, ...extra] = text.split('#').map(Number)
            ensure(kind === 13111 && !extra.length, 'Unsupported abyss unlock condition', ErrorCode.FunctionClosed)
            return hasPassed(tables, state, id, rotation)
        })
}
export function requireAbyssLevel(c, request) {
    const tables = abyssTables(c.tables),
        mode = abyssModeLevels(tables, request.mode, c.now),
        level = tables.find('abbys_level', request.abyss_level),
        system = tables.find('system_unlock', 1700)
    ensure(
        level?.mode === request.mode && mode.levels.includes(level.id),
        'Invalid challenge level in abyss mode',
        ErrorCode.AbyssInvalidChallengeLevel,
    )
    const [unlock, task, ...extra] = String(system?.unlockCondi ?? '')
        .split('#')
        .map(Number)
    ensure(
        unlock === 2007 && task > 0 && !extra.length,
        'Abyss system unlock configuration unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        c.state.taskRecords.some((x) => x.task_id === task && x.count > 0),
        'Abyss system is locked',
        ErrorCode.AbyssSysLock,
    )
    ensure(
        condition(tables, c.state, mode.row.condition, mode.rotation),
        'Previous abyss mode is not complete',
        ErrorCode.AbyssPreModeNotFinished,
    )
    ensure(
        condition(tables, c.state, level.condition, mode.rotation),
        'Abyss level is not open',
        ErrorCode.AbyssLevelNotOpen,
    )
    return { tables, level, ...mode }
}
export function abyssModeRecord(state, mode, rotation) {
    const root = (state.abyss ??= { modes: {} })
    root.modes ??= {}
    if (mode !== 3) return (root.modes[mode] ??= { levels: {}, starClaims: [] })
    if (root.rotation?.id !== rotation.id) root.rotation = { id: rotation.id, levels: {}, starClaims: [] }
    return root.rotation
}
export function createAbyssRun(c, request) {
    const context = requireAbyssLevel(c, request),
        { tables, level, rotation } = context,
        s = c.state
    ensure(
        !s.cultTrial && !s.entrust?.run && !s.storyCampaign && !s.multiCampaign,
        'Another dungeon is active',
        ErrorCode.AbyssLocatedMapLimit,
    )
    ensure(!s.abyssRun, 'An abyss challenge is already active', ErrorCode.AbyssLocatedMapLimit)
    const world = tables.find('world_city', s.world.map_id)
    ensure(
        [1, 3, 7].includes(world?.type),
        'Leave the current instance before challenging abyss',
        ErrorCode.AbyssLocatedMapLimit,
    )
    // Resolve every selected room now. Never charge/lock a team and then
    // discover an unresolved later scene in the same challenge.
    const rooms = String(level.dungeonId)
            .split('|')
            .map(Number)
            .map((id) => abyssRoute(tables, id)),
        roster = abyssChallengeRoster(tables, s, level, request),
        saved = abyssModeRecord(s, request.mode, rotation),
        old = saved.levels[level.id]
    const run = {
        version: 1,
        mode: request.mode,
        level_id: level.id,
        rotation_id: rotation?.id ?? 0,
        rotation_end: rotation?.effectiveEnd ?? 0,
        ...roster,
        rooms: rooms.map((x) => ({ ...x.route, dungeon_id: x.dungeon.id })),
        part_index: 0,
        map_id: rooms[0].route.map_id,
        dungeon_id: rooms[0].dungeon.id,
        phase: 'ready',
        start_time: c.now,
        total_battle_time: 0,
        dead_hero_ids: [],
        instance_id: s.nextAbyssInstanceId ?? 1,
        return_world: {
            map_id: s.world.map_id,
            point_id: s.world.point_id,
            area_id: s.world.area_id,
            pos: { ...s.world.pos },
            angle: s.world.angle,
        },
        previous_manager: structuredClone(s.player.group_mgrs.find((x) => x.type === 7) ?? null),
    }
    s.nextAbyssInstanceId = run.instance_id + 1
    s.abyssRun = run
    saved.levels[level.id] = {
        cur_level: level.id,
        challenge_list: structuredClone(run.challenges),
        passed: old?.passed === true,
        star_num: old?.star_num ?? 0,
        pass_level_reward_flag: old?.pass_level_reward_flag === true,
        task_tags_list: structuredClone(old?.task_tags_list ?? []),
    }
    installAbyssFormation(s)
    Object.assign(s.world, tables.position(rooms[0].point))
    return run
}
export function installAbyssFormation(state) {
    const run = state.abyssRun
    ensure(run, 'No abyss challenge formation', ErrorCode.AbyssNoChallengeList)
    state.player.group_mgrs = state.player.group_mgrs.filter((x) => x.type !== 7)
    state.player.group_mgrs.push({
        type: 7,
        cur_group: run.part_index + 1,
        src: 0,
        groups: run.challenges.map((part, i) => ({
            id: i + 1,
            group_name: Buffer.from('深渊编队' + (i + 1)).toString('base64'),
            control: part.control,
            heros: part.heros.map((x) => ({ hero_id: x.hero.hero_guid, pet_id: x.hero.pet_guid })),
        })),
    })
}
export function abyssDungeonInfo(state) {
    const run = state.abyssRun
    return {
        dungeon_id: run.dungeon_id,
        abyss_level: run.level_id,
        total_battle_time: run.total_battle_time,
        task_tags_list: run.task_tags ?? [],
        protect_enemy_list: [],
        is_retry: run.retry === true,
    }
}
export function abyssActorInfo(state) {
    const wire = ({ abyss, source_guid, ...actor }) => actor
    return { heros: state.abyssRun.heroes.map(wire), pets: state.abyssRun.pets.map(wire) }
}
