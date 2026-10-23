import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { teachingSceneVictory } from './teaching-scene-victory.js'
const caches = new WeakMap()
const tokens = (text) =>
    String(text ?? '')
        .split('|')
        .filter(Boolean)
        .map((x) => Number(x.split('#')[0]))
const key = (map) => JSON.stringify([...map].sort(([a], [b]) => a - b))

export function teachingConfig(tables, dungeon) {
    ensure(dungeon, 'Teaching dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    ensure(dungeon.dungeonType === 100, 'Teaching dungeon type mismatch', ErrorCode.InstanceTypeError)
    let cache = caches.get(tables)
    if (!cache) caches.set(tables, (cache = new Map()))
    if (cache.has(dungeon.id)) return cache.get(dungeon.id)
    const train = tables.get('train_task').find((x) => x.dungeonId === dungeon.id && [1, 2].includes(x.groupType))
    ensure(train, 'Unknown teaching task', ErrorCode.TrainTaskConfNone)
    const team = tokens(train.showTeamInterim)
    ensure(team.length, 'Teaching team configuration unavailable', ErrorCode.InstanceSceneConfNotExist)
    ensure(
        team.every((id) => Number.isInteger(id) && id > 0),
        'Invalid teaching team configuration',
        ErrorCode.GameConfig,
    )
    const candidates = tables.get('dungeon_scene').filter((scene) => {
        const members = tokens(scene.trailGroup)
        return members[0] === team[0] && tables.find('world_city', scene.id)?.type === 2
    })
    const opening = candidates.filter((scene) => JSON.stringify(tokens(scene.trailGroup)) === JSON.stringify(team))
    ensure(opening.length, 'Teaching opening scene unavailable', ErrorCode.InstanceSceneConfNotExist)
    ensure(opening.length === 1, 'Teaching opening scene is ambiguous', ErrorCode.GameConfig)
    const expectedRows = String(dungeon.enemy ?? '')
        .split('|')
        .filter(Boolean)
        .map((x) => x.split('#').map(Number))
    ensure(
        expectedRows.length &&
            expectedRows.every((row) => row.length === 2 && row.every((n) => Number.isSafeInteger(n) && n > 0)),
        'Invalid teaching enemy roster',
        ErrorCode.GameConfig,
    )
    const expected = new Map()
    for (const [id, count] of expectedRows) expected.set(id, (expected.get(id) ?? 0) + count)
    const roster = (scenes) => {
        const result = new Map()
        for (const scene of scenes) {
            const [kind, spawner, , , count] = teachingSceneVictory(tables, scene)
            ensure(Number.isInteger(count) && count > 0, 'Invalid teaching scene victory rule', ErrorCode.GameConfig)
            ensure(kind === 2500, 'Teaching scene victory rule is not supported', ErrorCode.InvalidLogic)
            const rows = tables.get(`worldmap_${scene.id}`).filter((x) => x.spawnerId === spawner)
            ensure(rows.length === count, 'Teaching scene victory roster changed', ErrorCode.GameConfig)
            for (const row of rows) {
                const group = tables.find('world_enemy_group', row.expandId)
                ensure(group, 'Teaching enemy group configuration unavailable', ErrorCode.NoEnemyConf)
                const packs = tokens(group.enemyList)
                ensure(
                    packs.length && packs.every((id) => Number.isInteger(id) && id > 0),
                    'Invalid teaching enemy group roster',
                    ErrorCode.GameConfig,
                )
                for (const pack of packs) {
                    const config = tables.find('enemy_pack', pack)
                    ensure(
                        config || tables.find('enemy', pack),
                        'Teaching enemy configuration unavailable',
                        ErrorCode.NoEnemyConf,
                    )
                    const id = config ? config.enemyId : pack
                    ensure(Number.isSafeInteger(id) && id > 0, 'Invalid teaching enemy reference', ErrorCode.GameConfig)
                    result.set(id, (result.get(id) ?? 0) + 1)
                }
            }
        }
        return result
    }
    // No direct dungeon->scene FK exists in these exports. Bind only when the
    // trial team AND complete enemy multiset establish a unique route.
    const choices = [[opening[0]], ...candidates.filter((s) => s !== opening[0]).map((s) => [opening[0], s])]
    const matches = choices.filter((scenes) => key(roster(scenes)) === key(expected))
    ensure(matches.length, 'Teaching scene roster mapping unavailable', ErrorCode.InstanceSceneConfNotExist)
    ensure(matches.length === 1, 'Teaching scene roster mapping is ambiguous', ErrorCode.GameConfig)
    const scenes = matches[0].map((scene) => {
        const city = tables.find('world_city', scene.id)
        const point = tables.get('world_borthpos').find((x) => x.cityId === scene.id && x.mainPoint === 1)
        ensure(point, 'Teaching entry point unavailable', ErrorCode.NotFoundBirthPoint)
        return { scene, city, point }
    })
    const value = { dungeon, scenes, train, taskIds: [], difficulty: dungeon.dungeonGroupOrder, stageConditions: false }
    cache.set(dungeon.id, value)
    return value
}
