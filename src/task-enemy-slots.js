import fs from 'node:fs'
const source = JSON.parse(fs.readFileSync(new URL('../configs/task-enemy-slots.json', import.meta.url), 'utf8'))
const counts = new Map(source.assets.map((asset) => [asset.id, asset.count]))

export function taskEnemyPacks(tables, group) {
    const override = group.__type_TaskEnemiesOverrideData ?? {}
    const row = tables.find('world_enemy_group', override.enemiesGroupId)
    const packs = String(row?.enemyList ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    const inline = Array.isArray(override.enemySlots)
        ? override.enemySlots
        : override.enemySlots
          ? [override.enemySlots]
          : []
    // Current TaskHelper0602f1d2 uses inline slots first, otherwise
    // GetTaskEnemyGroupSlots0600864d. Missing assets supply one zero slot.
    // FillDisplaySlot(null) displays only indices covered by these slots;
    // the remaining enemyList entries are Disappear, not kill requirements.
    const count =
        override.useInlineEnemySlots && inline.length ? inline.length : (counts.get(override.posAssetId ?? 0) ?? 1)
    return packs.slice(0, count)
}
