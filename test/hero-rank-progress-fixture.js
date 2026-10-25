import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { pairs } from '../src/battle.js'

export function heroRankProgressFixture(name, file) {
    const f = achievementFixture(name, file)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    const hero = (guid) => f.state().player.heros_info.heros.find((row) => row.guid === guid)
    const advance = (guid, rank) => {
        edit((state) => {
            // Test funding/level prerequisites only; progression itself uses
            // real6016 rune equip and6017 rank-up for every transition.
            state.player.heros_info.heros.find((row) => row.guid === guid).hero_lv = 100
            state.taskRecords ??= []
            for (const row of f.tables.get('world_difficulty').filter((row) => row.taskId))
                if (!state.taskRecords.some((record) => record.task_id === row.taskId))
                    state.taskRecords.push({ task_id: row.taskId, count: 1, time: 1799999990 })
        })
        const packets = []
        while (hero(guid).hero_rank < rank) {
            const current = f.tables
                .get('talent_rank')
                .find((row) => row.heroId === hero(guid).conf_id && row.rank === hero(guid).hero_rank)
            const ids = String(current.rankBreakthroughItem).split('|').map(Number)
            const costs = ids.flatMap((id) => {
                const rune = f.tables.find('talent_rune', id)
                return [
                    { item_type: 3, item_id: rune.runeItem, item_num: 1 },
                    ...[...pairs(rune.equipRuneCoin)].map(([item_id, item_num]) => ({
                        item_type: 10,
                        item_id,
                        item_num,
                    })),
                    { item_type: 10, item_id: 2, item_num: rune.equipRuneThroughCoin },
                ]
            })
            edit((state) =>
                grantRewards(f.tables, state, [
                    ...costs.map(({ item_type, item_id, item_num }) => ({
                        itemtype: item_type,
                        itemid: item_id,
                        itemnum: item_num,
                    })),
                    ...parseRewards(current.rankBreakthroughCoin),
                ]),
            )
            f.call('HeroRuneEquip', { hero_id: guid, slot_ids: ids.map((_, index) => index), costItems: costs })
            packets.push(...f.call('HeroRuneLevelUp', { hero_id: guid }))
            assert.equal(hero(guid).hero_rank, current.rank + 1)
        }
        return packets
    }
    return { ...f, edit, hero, advance }
}
