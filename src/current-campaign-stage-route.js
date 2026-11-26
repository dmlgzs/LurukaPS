import { campaignStagePlan } from './campaign-stage-plan.js'

// Current-table inference for an aggregate group victory whose declared
// common-graph stages are sparse. No absent graph slots or old group adapter
// are synthesized. Bind only a unique scene with an exact full preview roster.
export function currentCampaignStageRoute(tables, dungeon) {
    const victory = String(dungeon.victoryCondition).split('#').map(Number)
    if (
        victory.length !== 5 ||
        victory[0] !== 2500 ||
        victory[1] <= 0 ||
        victory[2] !== 0 ||
        victory[3] !== 0 ||
        victory[4] <= 1
    )
        return null
    const expected = new Map()
    for (const token of String(dungeon.enemy ?? '')
        .split('|')
        .filter(Boolean)) {
        const [id, count, ...extra] = token.split('#').map(Number)
        if (extra.length || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(count) || count <= 0)
            return null
        expected.set(id, (expected.get(id) ?? 0) + count)
    }
    const matches = []
    for (const scene of tables.get('dungeon_scene')) {
        const indexes = [...String(scene.stringParam).matchAll(/(?:^|\|)finish_con_intlist(?:_(\d+))?#/g)]
            .map((match) => Number(match[1] ?? 0))
            .sort((a, b) => a - b)
        if (
            !indexes.length ||
            indexes.every((value, index) => value === index) ||
            scene.victoryCondition !== dungeon.victoryCondition ||
            tables.find('world_city', scene.id)?.type !== 2
        )
            continue
        if (
            !/^Config\/World\/Graph\/Blueprint\/ast_(?:story_)?dungeon_ai_common\.asset$/.test(
                tables.find('world_blueprint', scene.blueprintId)?.path ?? '',
            )
        )
            continue
        const plan = campaignStagePlan(tables, scene.id),
            rows = tables.get('worldmap_' + scene.id)
        if (plan.flat().length !== victory[4] || !plan.flat().every((row) => row.spawnerId === victory[1])) continue
        const actual = new Map()
        for (const row of rows.filter((row) => tables.find('world_spawner', row.spawnerId)?.objectType === 50)) {
            for (const id of String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
                .map(Number)) {
                const pack = tables.find('enemy_pack', id)
                if (!pack) return null
                actual.set(pack.enemyId, (actual.get(pack.enemyId) ?? 0) + 1)
            }
        }
        if (actual.size !== expected.size || ![...expected].every(([id, count]) => actual.get(id) === count)) continue
        if (!tables.get('world_borthpos').some((row) => row.cityId === scene.id && row.mainPoint === 1)) continue
        matches.push({
            dungeon_id: dungeon.id,
            scene_ids: [scene.id],
            mode: 'current_declared_stages',
            source: 'current_table_inference',
            declared_stage_indexes: indexes,
            basis: 'Exact current aggregate victory, sparse declared stage rows, full enemy and friendly roster, and unique current common scene',
            todo: 'Current blueprint body/server formula not exported; scene binding and declared-stage order remain an explicitly bounded local model',
        })
    }
    return matches.length === 1 ? matches[0] : null
}
