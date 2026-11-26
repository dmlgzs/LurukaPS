import { currentSceneTrialRoster } from './current-scene-trials.js'
import { teachingSceneVictory } from './teaching-scene-victory.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const positive = (n) => Number.isSafeInteger(n) && n > 0
const signature = (map) => JSON.stringify([...map].sort(([a], [b]) => a - b))
const prefix = (a, b) => a.length < b.length && a.every((value, index) => value === b[index])
function identities(tables, ids) {
    return ids.map((id) => {
        const cfg = tables.find('hero_interim', id)
        ensure(
            cfg && positive(cfg.heroId) && tables.find('hero', cfg.heroId),
            'Teaching preview hero configuration is unavailable',
            ErrorCode.HeroNotExist,
        )
        return cfg.heroId
    })
}
function roster(tables, scene) {
    const counts = new Map(),
        groups = []
    for (const row of tables.get('worldmap_' + scene.id)) {
        if (tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
        const group = tables.find('world_enemy_group', row.expandId)
        ensure(group, 'Teaching enemy group configuration is unavailable', ErrorCode.NoEnemyConf)
        const packs = String(group.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(packs.length > 0, 'Teaching enemy pool is empty', ErrorCode.NoEnemyConf)
        for (const id of packs) {
            const pack = tables.find('enemy_pack', id)
            ensure(
                pack && tables.find('enemy', pack.enemyId),
                'Teaching enemy pack configuration is unavailable',
                ErrorCode.NoEnemyConf,
            )
            counts.set(pack.enemyId, (counts.get(pack.enemyId) ?? 0) + 1)
        }
        groups.push({ id: row.id, normalPoolWithFsm: group.enemyGroupType === 3 && positive(group.battleFsmType) })
    }
    ensure(groups.length > 0, 'Teaching scene has no configured battle group', ErrorCode.NoEnemyConf)
    teachingSceneVictory(tables, scene)
    return { counts, groups }
}
// Current preview identities select typed trial groups, never old trailGroup
// strings. Static character trials require complete current roster equality.
// Mechanics lessons keep the actual Normal-group/FSM pool (enum3 is Normal): preview counts must not
// be used to manufacture duplicate enemies.
export function currentTeachingRoute(tables, dungeon, train) {
    const preview = String(train.showTeamInterim ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(preview.length > 0 && preview.every(positive), 'Teaching preview team is malformed', ErrorCode.GameConfig)
    const wanted = identities(tables, preview),
        expected = new Map()
    for (const token of String(dungeon.enemy ?? '')
        .split('|')
        .filter(Boolean)) {
        const [id, count, ...extra] = token.split('#').map(Number)
        ensure(
            !extra.length && positive(id) && positive(count),
            'Teaching preview enemy roster is malformed',
            ErrorCode.GameConfig,
        )
        expected.set(id, (expected.get(id) ?? 0) + count)
    }
    ensure(expected.size > 0, 'Teaching preview enemy roster is unavailable', ErrorCode.GameConfig)
    const candidates = []
    for (const scene of tables.get('dungeon_scene')) {
        if (
            tables.find('world_city', scene.id)?.type !== 2 ||
            tables.find('world_blueprint', scene.blueprintId)?.path !==
                'Config/World/Graph/Blueprint/ast_teaching_dungeon_01.asset'
        )
            continue
        const raw = tables.find('heropet_interim_group', scene.trialsId)
        const first = Number(
            String(raw?.hero_id ?? '')
                .split('|')[0]
                .split('#')[1],
        )
        if (tables.find('hero_interim', first)?.heroId !== wanted[0]) continue
        const enemies = roster(tables, scene)
        if ([...enemies.counts].some(([id, count]) => !expected.has(id) || count > expected.get(id))) continue
        const current = currentSceneTrialRoster(tables, scene),
            heroes = identities(
                tables,
                current.heroes.map((hero) => hero.id),
            )
        if (
            train.groupType === 1 &&
            (heroes.length !== wanted.length || heroes.some((hero, index) => hero !== wanted[index]))
        )
            continue
        candidates.push({ scene, current, heroes, ...enemies })
    }
    const merge = (rows) => {
        const out = new Map()
        for (const row of rows) for (const [id, count] of row.counts) out.set(id, (out.get(id) ?? 0) + count)
        return out
    }
    const exact = []
    for (const row of candidates) if (signature(row.counts) === signature(expected)) exact.push([row])
    for (const first of candidates)
        for (const second of candidates)
            if (prefix(first.heroes, second.heroes) && signature(merge([first, second])) === signature(expected))
                exact.push([first, second])
    let selected,
        routeModel = 'current-identities-and-complete-static-roster'
    if (exact.length === 1) selected = exact[0]
    else if (train.groupType === 1) {
        const scripted = candidates.filter((row) => row.groups.every((group) => group.normalPoolWithFsm))
        ensure(
            scripted.length === 1,
            'Current scripted teaching route is unavailable or ambiguous',
            ErrorCode.InstanceSceneConfNotExist,
        )
        selected = [scripted[0]]
        routeModel = 'current-identities-and-fsm-palette'
    } else
        ensure(
            false,
            exact.length ? 'Current teaching route is ambiguous' : 'Current teaching route is unavailable',
            exact.length ? ErrorCode.GameConfig : ErrorCode.InstanceSceneConfNotExist,
        )
    const scenes = selected.map(({ scene, current }) => {
        const points = tables.get('world_borthpos').filter((row) => row.cityId === scene.id && row.mainPoint === 1)
        ensure(
            points.length === 1,
            'Current teaching entry point is unavailable or ambiguous',
            ErrorCode.NotFoundBirthPoint,
        )
        tables.position(points[0])
        return { scene, city: tables.find('world_city', scene.id), point: points[0], trialGroupId: current.groupId }
    })
    return {
        dungeon,
        scenes,
        train,
        taskIds: [],
        difficulty: dungeon.dungeonGroupOrder,
        stageConditions: false,
        routeModel,
        todo:
            routeModel === 'current-identities-and-fsm-palette'
                ? 'Preview counts are not static spawn counts; the current group FSM owns scripted spawns. Full challenge execution needs its own validation.'
                : undefined,
    }
}
