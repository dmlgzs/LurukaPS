import { abyssTables } from './abyss-catalog.js'
import { activeAbyssRotation } from './abyss-rotation.js'
import { abyssBattlePlan } from './abyss-battle-config.js'
import { ensureAbyssScene } from './abyss-scene.js'
import { abyssModeRecord, abyssDungeonInfo } from './abyss-run.js'
import { abyssDataSnapshot } from './abyss-data.js'
import { completedEnemyGroup } from './enemy-group-completion.js'
import { heroBattleLimits } from './battle.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { beginAbyssIntro, publishAbyssIntro } from './abyss-intro.js'
export function requireAbyssRun(c) {
    const run = c.state.abyssRun
    ensure(run && run.map_id === c.state.world.map_id, 'No current abyss challenge', ErrorCode.AbyssNoChallengeList)
    if (run.mode === 3) {
        const rotation = activeAbyssRotation(abyssTables(c.tables), c.now)
        ensure(rotation?.id === run.rotation_id, 'Abyss rotation changed', ErrorCode.AbyssRotationChange)
        run.rotation_end = rotation.effectiveEnd
    }
    return run
}
function heroStates(state) {
    return new Map(state.player.heros_info.battle_infos.map((x) => [x.hero_id, x]))
}
export function abyssRunTime(run, now) {
    return (
        run.total_battle_time +
        (run.phase === 'running'
            ? Math.max(0, now - run.real_start_time)
            : run.phase === 'intro'
              ? run.intro.elapsed_before
              : 0)
    )
}
export function abyssTimeoutDue(external, state, now) {
    const run = state.abyssRun
    if (!run || run.map_id !== state.world.map_id || run.phase !== 'running') return false
    ensure(
        [now, run.real_start_time, run.total_battle_time].every((value) => Number.isSafeInteger(value) && value >= 0),
        'Abyss timer state is malformed',
        ErrorCode.GameConfig,
    )
    if (abyssRunTime(run, now) < abyssBattlePlan(external, run.dungeon_id).limit) return false
    return {
        instance_id: run.instance_id,
        map_id: run.map_id,
        part_index: run.part_index,
        dungeon_id: run.dungeon_id,
        real_start_time: run.real_start_time,
    }
}
export function expireAbyssTimeout(c, expected) {
    const due = abyssTimeoutDue(c.tables, c.state, c.now)
    if (!due || !expected || Object.keys(due).some((key) => due[key] !== expected[key])) return false
    // Reuse the actual defeat/ledger/scene producer. A timer never marks a wave
    // dead, starts another room, grants stars or creates reward receipts.
    return advanceAbyssCombat(c)
}
export function abyssTaskTags(tables, run, now, final = false) {
    const elapsed = abyssRunTime(run, now),
        fallen = run.dead_hero_ids.length,
        level = abyssTables(tables).find('abbys_level', run.level_id)
    return String(level.challenge)
        .split('|')
        .map((text, index) => {
            const [kind, a, b, ...extra] = text.split('#').map(Number)
            ensure(
                !extra.length &&
                    ((kind === 3006 && a > 0 && b === undefined) || (kind === 60007 && a === 0 && b === 1)),
                'Unsupported abyss star condition',
                ErrorCode.GameConfig,
            )
            // The actual level descriptions pair 60007#0#1 with “无人倒地”.
            // Count unique formation hero deaths, matching the client's alive-state
            // listener; pet deaths and repeated death reports cannot increment it.
            const failed = kind === 3006 ? elapsed >= a : fallen >= b
            return {
                tag_type: index,
                tag_progress: String(kind === 3006 ? elapsed : fallen),
                status: failed ? 3 : final ? 2 : 1,
            }
        })
}
function saveAbyssProgress(c) {
    const s = c.state,
        run = s.abyssRun
    // Only completion needs a writable progress ledger. Ordinary combat only
    // updates the small runtime fork and the existing battle-info arrays.
    s.abyss = { ...s.abyss, modes: { ...s.abyss?.modes } }
    if (run.mode === 3) s.abyss.rotation = { ...s.abyss.rotation, levels: { ...s.abyss.rotation.levels } }
    else s.abyss.modes[run.mode] = { ...s.abyss.modes[run.mode], levels: { ...s.abyss.modes[run.mode].levels } }
    const saved = abyssModeRecord(s, run.mode, { id: run.rotation_id }),
        old = saved.levels[run.level_id],
        passed = run.phase === 'won' && run.part_index === run.rooms.length - 1 && run.challenges.every((x) => x.win),
        stars = passed ? run.task_tags.filter((x) => x.status === 2).length : 0
    saved.levels[run.level_id] = {
        ...old,
        challenge_list: structuredClone(run.challenges),
        passed: old.passed || passed,
        star_num: Math.max(old.star_num ?? 0, stars),
        task_tags_list: passed && stars >= (old.star_num ?? 0) ? run.task_tags : old.task_tags_list,
    }
    c.push('SCProtoAbyssLevelInfoUpdate', {
        mode: run.mode,
        level_info: abyssDataSnapshot(abyssTables(c.tables), s, c.now)[
            ['newer', 'persistent', 'rotation'][run.mode - 1] + '_mode_info'
        ].find((x) => x.cur_level === run.level_id),
    })
}
export function syncAbyssBattleScene(c) {
    const run = c.state.abyssRun
    ensureAbyssScene(c.tables, c.state, c.now)
    c.push('SCProtoAbyssDungeonInfoSync', { ...abyssDungeonInfo(c.state), task_tags_list: run.task_tags ?? [] })
    c.push('CSProtoWorldMapSync', {
        cmd: 47,
        creator_id: c.id,
        map_id: run.map_id,
        map_info: { creator_id: c.id, map_id: run.map_id, objs: run.scene_objects },
    })
    const infos = run.scene_objects
        .filter((x) => x.active && run.wave_objects?.includes(x.obj_id))
        .flatMap((x) => x.expand_data.battle_group.monsters.filter((x) => x.hp > 0))
        .map((x) => ({ uuid: x.uid, hp: x.hp, sp: 0, alive_state: 0, reason: 1 }))
    if (infos.length) c.push('CSProtoObjBattleInfoSync', { infos })
}
export function startAbyssBattle(c) {
    const run = requireAbyssRun(c),
        plan = abyssBattlePlan(c.tables, run.dungeon_id)
    if (run.phase === 'intro') {
        syncAbyssBattleScene(c)
        publishAbyssIntro(c)
        return {}
    }
    if (run.phase === 'running') {
        if (advanceAbyssCombat(c)) return {}
        syncAbyssBattleScene(c)
        return {}
    }
    ensure(run.phase === 'ready', 'Abyss room is already settled', ErrorCode.AbyssInvalidChallengeLevel)
    run.phase = 'running'
    run.real_start_time = c.now
    run.wave_index = 0
    run.wave_objects = plan.waves[0].objects.slice()
    run.completed_objects = []
    beginAbyssIntro(c)
    run.task_tags = abyssTaskTags(c.tables, run, c.now)
    syncAbyssBattleScene(c)
    publishAbyssIntro(c)
    return {}
}
export function updateAbyssPetHealth(c, id, delta) {
    const run = c.state.abyssRun
    if (!run || run.map_id !== c.state.world.map_id || !run.petAttrs[id]) return null
    const max = heroBattleLimits(run.petAttrs[id]).hp,
        old = run.pet_hp?.[id] ?? max,
        hp = old === 0 ? 0 : Math.max(0, Math.min(max, old + delta))
    run.pet_hp = { ...run.pet_hp, [id]: hp }
    return { uuid: id, hp, sp: c.state.combat?.petSp?.[id] ?? 0, alive_state: hp > 0 ? 0 : 1, reason: 0 }
}
function settleAbyssRoom(c, win) {
    forkAbyssScene(c)
    const run = c.state.abyssRun,
        states = heroStates(c.state),
        part = run.challenges[run.part_index],
        cost = Math.max(0, c.now - run.real_start_time)
    run.total_battle_time += cost
    run.phase = win ? 'won' : 'lost'
    run.end_time = c.now
    run.challenges = run.challenges.map((x, i) =>
        i !== run.part_index
            ? x
            : {
                  ...part,
                  win,
                  battle_time: cost,
                  dead_hero_num: part.heros.filter((x) => run.dead_hero_ids.includes(x.hero.hero_guid)).length,
                  heros: part.heros.map((x) => ({
                      ...x,
                      hp: states.get(x.hero.hero_guid)?.hp ?? 0,
                      pet_hp: x.hero.pet_guid === '0' ? 0 : (run.pet_hp?.[x.hero.pet_guid] ?? x.pet_hp),
                  })),
              },
    )
    const final = win && run.part_index === run.rooms.length - 1
    run.task_tags = abyssTaskTags(c.tables, run, c.now, final)
    if (!win) run.task_tags = run.task_tags.map((x) => ({ ...x, status: 3 }))
    saveAbyssProgress(c)
    syncAbyssBattleScene(c)
    c.push('CSProtoAbyssDungeonEndSync', {
        type: run.mode,
        state: win ? 3 : 4,
        star: final ? run.task_tags.filter((x) => x.status === 2).length : 0,
        cost_time: cost,
        total_cost_time: run.total_battle_time,
        heros: run.challenges[run.part_index].heros,
        last_dungeon: run.part_index === run.rooms.length - 1,
        task_tags_list: run.task_tags,
    })
}
function forkAbyssScene(c) {
    const run = c.state.abyssRun
    c.state.worldObjects = { ...c.state.worldObjects }
    for (const row of run.scene_objects ?? []) {
        const key = run.map_id + ':' + row.obj_id
        c.state.worldObjects[key] = { ...c.state.worldObjects[key] }
    }
}
export function advanceAbyssCombat(c) {
    const run = c.state.abyssRun
    if (!run || run.map_id !== c.state.world.map_id || run.phase !== 'running') return false
    const plan = abyssBattlePlan(c.tables, run.dungeon_id),
        states = heroStates(c.state),
        ids = run.challenges[run.part_index].heros.map((x) => x.hero.hero_guid).filter((x) => x !== '0')
    for (const id of ids) if (states.get(id)?.hp === 0 && !run.dead_hero_ids.includes(id)) run.dead_hero_ids.push(id)
    if (
        (run.rotation_end && c.now >= run.rotation_end) ||
        abyssRunTime(run, c.now) >= plan.limit ||
        ids.every((id) => states.get(id)?.hp === 0)
    ) {
        settleAbyssRoom(c, false)
        return true
    }
    // The compiled current-wave slots are tiny. Do not resolve all table/task
    // enemy definitions again on every hit; verify the full group only at death.
    if (!run.wave_objects.every((id) => plan.slots.get(id).every((x) => c.state.combat?.entities[x.uuid]?.hp === 0)))
        return false
    if (
        !run.wave_objects.every((id) =>
            completedEnemyGroup(abyssTables(c.tables), c.state, ((3n << 56n) | BigInt(id)).toString()),
        )
    )
        return false
    forkAbyssScene(c)
    run.completed_objects = [...(run.completed_objects ?? []), ...run.wave_objects]
    const next = plan.waves[run.wave_index + 1]
    if (next) {
        run.wave_index++
        run.wave_objects = next.objects.slice()
        beginAbyssIntro(c)
        run.task_tags = abyssTaskTags(c.tables, run, c.now)
        syncAbyssBattleScene(c)
        publishAbyssIntro(c)
    } else settleAbyssRoom(c, true)
    return true
}
