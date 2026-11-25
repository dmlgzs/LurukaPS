import { readTable } from './table-source.js'
const rules = new Map(readTable('common_item').map((row) => [row.id, row]))
export function giveAllRewards(tables, state) {
    const rewards = tables
        .get('common_item')
        .map((row) => {
            const numeric = rules.get(row.id) ?? row
            const stack = numeric.stackNum
            const max = numeric.maxNum
            const single = stack === 1 || max === 1
            const owned = (state.player.sbag_infos?.items ?? []).some((i) => i.itemid === row.id && i.itemnum > 0)
            return { itemtype: 3, itemid: row.id, itemnum: single ? (owned ? 0 : 1) : 999 }
        })
        .filter((r) => r.itemnum > 0)
    // Equipment is an individual entity; preserve already owned/upgraded instances.
    for (const row of tables.get('soulessence'))
        if (!state.player.soulessence_infos.soulessences.some((e) => e.id === row.id))
            rewards.push({ itemtype: 9, itemid: row.id, itemnum: 1 })
    return rewards
}
