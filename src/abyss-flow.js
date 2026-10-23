import { requireAbyssRun, abyssTaskTags } from './abyss-battle.js'
import { abyssTables, abyssRoute } from './abyss-catalog.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { heroBattleLimits, syncBattle } from './battle.js'
import { retireTrialActors } from './trial-actors.js'
import { abyssModeRecord } from './abyss-run.js'
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
export function saveAbyssCheckpoint(state) {
    const run = state.abyssRun
    if (!run) return null
    if (run.mode === 3 && state.abyss?.rotation?.id !== run.rotation_id) return null
    let won = 0
    while (run.challenges[won]?.win) won++
    const mode = abyssModeRecord(state, run.mode, { id: run.rotation_id }),
        record = mode.levels[run.level_id]
    ensure(record, 'Abyss progress ledger is missing', ErrorCode.GameConfig)
    if (won === 0 || won === run.challenges.length) {
        delete record.resume
        return null
    }
    const completedHeroes = new Set(run.challenges.slice(0, won).flatMap((x) => x.heros.map((x) => x.hero.hero_guid))),
        challenges = run.challenges.map((part, i) =>
            i < won
                ? structuredClone(part)
                : {
                      ...structuredClone(part),
                      win: false,
                      battle_time: 0,
                      dead_hero_num: 0,
                      heros: part.heros.map((x) => ({
                          ...structuredClone(x),
                          hp: x.hero.hero_guid === '0' ? 0 : heroBattleLimits(run.heroAttrs[x.hero.hero_guid]).hp,
                          pet_hp: x.hero.pet_guid === '0' ? 0 : heroBattleLimits(run.petAttrs[x.hero.pet_guid]).hp,
                      })),
                  },
        ),
        checkpoint = {
            version: 1,
            mode: run.mode,
            level_id: run.level_id,
            rotation_id: run.rotation_id,
            completed_parts: won,
            challenges,
            total_battle_time: challenges.slice(0, won).reduce((sum, x) => sum + x.battle_time, 0),
            dead_hero_ids: run.dead_hero_ids.filter((id) => completedHeroes.has(id)),
            heroes: structuredClone(run.heroes),
            pets: structuredClone(run.pets),
            heroAttrs: structuredClone(run.heroAttrs),
            petAttrs: structuredClone(run.petAttrs),
        }
    record.resume = checkpoint
    record.challenge_list = structuredClone(challenges)
    return checkpoint
}
export function clearAbyssRuntime(c) {
    const s = c.state,
        run = s.abyssRun
    if (!run) return false
    saveAbyssCheckpoint(s)
    const copies = new Set(run.heroes.map((x) => x.guid)),
        restored = run.previous_manager ?? { type: 7, cur_group: 0, src: 0, groups: [] },
        maps = new Set(run.rooms.map((x) => x.map_id))
    s.player.group_mgrs = s.player.group_mgrs.filter((x) => x.type !== 7)
    if (run.previous_manager) s.player.group_mgrs.push(structuredClone(run.previous_manager))
    s.player.heros_info.battle_infos = s.player.heros_info.battle_infos.filter((x) => !copies.has(x.hero_id))
    retireTrialActors(s, [...run.heroes, ...run.pets])
    for (const key of Object.keys(s.worldObjects ?? {}))
        if (maps.has(Number(key.split(':')[0]))) delete s.worldObjects[key]
    delete s.abyssRun
    delete s.combat
    c.push('CSProtoSyncPlayerData', { group_mgrs: [restored] })
    c.push('CSProtoOnlineModeChange', { mode: 1 })
    syncBattle(c)
    return true
}
