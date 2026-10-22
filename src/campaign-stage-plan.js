import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
export function campaignStagePlan(tables, mapId) {
    const scene = tables.find('dungeon_scene', mapId),
        objects = tables.get('worldmap_' + mapId)
    const entries = String(scene?.stringParam ?? '')
        .split('|')
        .flatMap((token) => {
            const at = token.indexOf('#'),
                key = token.slice(0, at),
                match = /^finish_con_intlist(?:_(\d+))?$/.exec(key)
            return match
                ? [
                      {
                          index: Number(match[1] ?? 0),
                          parts: token
                              .slice(at + 1)
                              .split(',')
                              .map(Number),
                      },
                  ]
                : []
        })
        .sort((a, b) => a.index - b.index)
    ensure(
        entries.length > 0 &&
            entries.every(
                (e, i) =>
                    e.index === i &&
                    e.parts.length === 5 &&
                    e.parts.every(Number.isSafeInteger) &&
                    e.parts[0] === 2500 &&
                    e.parts[1] >= 0 &&
                    (e.parts[1] > 0 || e.parts[3] > 0) &&
                    e.parts[4] > 0,
            ),
        'Campaign stage conditions unavailable',
        ErrorCode.GameConfig,
    )
    const used = new Set()
    return entries.map(({ parts: [, spawner, , objectId, count] }) => {
        const candidates = objects
            .filter(
                (row) =>
                    (!spawner || row.spawnerId === spawner) && !used.has(row.id) && (!objectId || row.id === objectId),
            )
            .sort((a, b) => Number(a.commonTag) - Number(b.commonTag))
        ensure(
            candidates.length >= count && candidates.every((row) => /^\d+$/.test(String(row.commonTag))),
            'Campaign stage objects unavailable',
            ErrorCode.GameConfig,
        )
        const rows = candidates.slice(0, count)
        rows.forEach((row) => used.add(row.id))
        return rows
    })
}
export function campaignStageSatisfied(tables, state, rows) {
    return rows.every((row) => {
        const type = tables.find('world_spawner', row.spawnerId)?.objectType
        if (type === 50) {
            const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
                .map(Number)
            return (
                packs.length > 0 &&
                packs.every((pack, slot) => {
                    const e = state.combat?.entities[((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()]
                    return e?.hp === 0 && e.alive_state === 1 && !e.captured && e.pack_id === pack
                })
            )
        }
        const record = state.worldObjects?.[state.world.map_id + ':' + row.id]
        return record?.complete === true || record?.state_data?.complete === true
    })
}

// The shared CBT3 dungeon graph creates friendly groups with the same
// commonTag as an unlocked battle wave. initStatus is not a permanent ban.
export function campaignFriendlyGroupAvailable(tables, state, row) {
    const run = state.storyCampaign
    if (!run?.stage_conditions || run.status !== 2 || run.map_id !== state.world.map_id || row.cityId !== run.map_id)
        return false
    if (tables.find('world_spawner', row.spawnerId)?.objectType !== 50) return false
    const group = tables.find('world_enemy_group', row.expandId)
    const packs = String(group?.enemyList ?? '')
        .split('|')
        .filter(Boolean)
        .map((id) => tables.find('enemy_pack', Number(id)))
    if (
        !packs.length ||
        group.campType !== 2 ||
        !packs.every((pack) => pack?.ECampType === 2 && pack.specialCreateType === 1)
    )
        return false
    const tags = new Set(
        campaignStagePlan(tables, run.map_id)
            .slice(0, (run.stage_index ?? 0) + 1)
            .flat()
            .map((r) => String(r.commonTag)),
    )
    return /^\d+$/.test(String(row.commonTag)) && tags.has(String(row.commonTag))
}
