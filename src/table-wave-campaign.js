import { campaignPlayableStagePlan } from './campaign-playable-route.js'
import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import path from 'node:path'
import { campaignStagePlan } from './campaign-stage-plan.js'
const routeCache = new WeakMap()
// Table-derived compatibility: an exact roster + victory uniquely identifies a
// single common dungeon scene. This is not an official dungeon->scene foreign key.
export function tableWaveCampaignRoute(tables, dungeon) {
    const parts = String(dungeon.victoryCondition).split('#').map(Number)
    if (
        parts.length !== 5 ||
        !parts.every(Number.isSafeInteger) ||
        parts[0] !== 2500 ||
        parts[2] !== 0 ||
        parts[1] < 0 ||
        parts[3] < 0 ||
        (!parts[1] && !parts[3]) ||
        parts[4] <= 0
    )
        return null
    const expected = new Map()
    for (const token of String(dungeon.enemy ?? '').split('|')) {
        const [id, count] = token.split('#').map(Number)
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(count) || count <= 0) return null
        expected.set(id, (expected.get(id) ?? 0) + count)
    }
    const signature = dungeon.victoryCondition + ':' + JSON.stringify([...expected].sort((a, b) => a[0] - b[0]))
    let cache = routeCache.get(tables)
    if (!cache) routeCache.set(tables, (cache = new Map()))
    if (cache.has(signature)) {
        const saved = cache.get(signature)
        return saved ? { ...saved, dungeon_id: dungeon.id } : null
    }
    const matches = []
    for (const scene of tables.get('dungeon_scene')) {
        if (
            scene.victoryCondition !== dungeon.victoryCondition ||
            tables.find('world_city', scene.id)?.type !== 2 ||
            !/^Config\/World\/Graph\/Blueprint\/ast_(?:story_)?dungeon_ai_common\.asset$/.test(
                tables.find('world_blueprint', scene.blueprintId)?.path ?? '',
            )
        )
            continue
        if (!fs.existsSync(path.join(tables.dir, 'worldmap_' + scene.id + '.json'))) continue
        const conditions = String(scene.stringParam)
            .split('|')
            .filter((s) => /^finish_con_intlist(?:_\d+)?#/.test(s))
            .sort(
                (a, b) =>
                    Number(a.split('#')[0].match(/_(\d+)$/)?.[1] ?? 0) -
                    Number(b.split('#')[0].match(/_(\d+)$/)?.[1] ?? 0),
            )
        const end = conditions.findIndex(
            (s) =>
                s
                    .slice(s.indexOf('#') + 1)
                    .split(',')
                    .join('#') === dungeon.victoryCondition,
        )
        if (end < 0 || !tables.get('world_borthpos').some((p) => p.cityId === scene.id && p.mainPoint === 1)) continue
        let plan
        try {
            plan = campaignStagePlan(tables, scene.id)
        } catch (error) {
            if (error.code === ErrorCode.GameConfig) continue
            throw error
        }
        const rows = plan[end] ?? []
        if (rows.length !== parts[4]) continue
        if (!rows.every((r) => (!parts[1] || r.spawnerId === parts[1]) && (!parts[3] || r.id === parts[3]))) continue
        const actual = new Map()
        let valid = true
        // A targeted final group does not describe the earlier combat waves.
        // Verify the complete prerequisite roster, including story/interact stages.
        const battleRows = plan
            .slice(0, end + 1)
            .flat()
            .filter((row) => tables.find('world_spawner', row.spawnerId)?.objectType === 50)
        for (const row of battleRows) {
            const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
            if (!packs.length) valid = false
            for (const pack of packs) {
                const id = tables.find('enemy_pack', Number(pack))?.enemyId
                if (!id) valid = false
                actual.set(id, (actual.get(id) ?? 0) + 1)
            }
        }
        if (!valid) continue
        const exactRoster = actual.size === expected.size && [...expected].every(([id, n]) => actual.get(id) === n)
        // A concrete object target plus exact scene victory is stronger than
        // the generic spawner-only join. Current CBT3 has stale enemy preview
        // IDs in such dungeons; never substitute those IDs into scene packs.
        if (
            !exactRoster &&
            (!parts[3] ||
                [...actual.values()].reduce((a, b) => a + b, 0) !== [...expected.values()].reduce((a, b) => a + b, 0))
        )
            continue
        matches.push({
            dungeon_id: dungeon.id,
            scene_ids: [scene.id],
            mode: 'table_waves',
            victory_stage_count: end + 1,
            source: 'table_inference',
            basis: exactRoster
                ? 'Unique common dungeon scene matching exact victory and complete enemyId/count roster'
                : 'Unique story dungeon scene matching exact targeted victory and total enemy count; scene packs override inconsistent preview IDs',
            preview_roster_matches: exactRoster,
            todo: 'Verify scene selection against official CBT3 route; table matching is a local compatibility inference',
        })
    }
    const route = matches.length === 1 ? matches[0] : null
    cache.set(signature, route)
    return route
}
export function storyCampaignStagePlan(tables, run) {
    if (run.local_playable_condition) return campaignPlayableStagePlan(tables, run.map_id)
    const plan = campaignStagePlan(tables, run.map_id)
    return run.victory_stage_count ? plan.slice(0, run.victory_stage_count) : plan
}
