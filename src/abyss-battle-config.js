import { abyssTables, abyssRoute } from './abyss-catalog.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const catalogues = new WeakMap()
export function abyssBattlePlan(external, dungeonId) {
    const tables = abyssTables(external)
    let catalog = catalogues.get(tables)
    if (!catalog) catalogues.set(tables, (catalog = new Map()))
    if (catalog.has(dungeonId)) return catalog.get(dungeonId)
    const { route, dungeon } = abyssRoute(tables, dungeonId),
        scene = tables.find('dungeon_scene', route.map_id),
        rows = tables.get('worldmap_' + route.map_id),
        battle = route.object_ids.map((id) => rows.find((x) => x.id === id)),
        victory = String(dungeon.victoryCondition).split('#').map(Number),
        markers = rows.filter((x) => x.spawnerId === 6021401)
    ensure(
        scene?.blueprintId === 300307 &&
            markers.length === 1 &&
            victory.length === 5 &&
            victory[0] === 2500 &&
            victory[1] === 99016 &&
            victory[2] === 0 &&
            victory[3] === 0 &&
            victory[4] === battle.length,
        'Unsupported abyss scene battle contract',
        ErrorCode.GameConfig,
    )
    const waves = new Map(),
        scales = new Map(),
        slots = new Map()
    for (const row of battle) {
        const tags = String(row?.commonTag).split('|').map(Number)
        ensure(tags.length === 1 && [2, 3, 4].includes(tags[0]), 'Unsupported abyss wave tags', ErrorCode.GameConfig)
        if (!waves.has(tags[0])) waves.set(tags[0], [])
        waves.get(tags[0]).push(row.id)
        const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(packs.length > 0 && packs.length <= 256, 'Invalid abyss group slots', ErrorCode.NoEnemyConf)
        slots.set(
            row.id,
            packs.map((pack, slot) => ({
                pack,
                uuid: ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString(),
            })),
        )
    }
    for (const text of String(dungeon.difficultIndex).split('|').filter(Boolean)) {
        const [id, ...values] = text.split('#').map(Number),
            attrs = new Map()
        ensure(
            id > 0 && values.length % 2 === 0 && values.every(Number.isSafeInteger),
            'Invalid abyss dungeon scaling',
            ErrorCode.GameConfig,
        )
        for (let i = 0; i < values.length; i += 2) attrs.set(values[i], values[i + 1])
        scales.set(id, attrs)
    }
    const time = String(dungeon.failCondition)
            .split('||')
            .map((x) => x.split('#').map(Number)),
        timed = time.find((x) => x[0] === 2901),
        fallen = time.find((x) => x[0] === 3009)
    ensure(
        time.length === 2 && timed?.length === 2 && timed[1] > 0 && fallen?.length === 2 && fallen[1] === 1,
        'Unsupported abyss defeat conditions',
        ErrorCode.GameConfig,
    )
    const plan = {
        marker: markers[0].id,
        waves: [...waves].sort((a, b) => a[0] - b[0]).map(([tag, objects]) => ({ tag, objects })),
        scales,
        slots,
        limit: timed[1],
        object_ids: route.object_ids,
    }
    catalog.set(dungeonId, plan)
    return plan
}
export function abyssEnemyHpScale(tables, dungeonId, objectId) {
    return abyssBattlePlan(tables, dungeonId).scales.get(objectId)?.get(5) ?? 10000
}
