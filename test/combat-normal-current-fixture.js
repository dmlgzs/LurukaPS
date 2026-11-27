import assert from 'node:assert/strict'
import { grantRewards } from '../src/rewards.js'
import { refreshBattleState } from '../src/battle.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { configTime } from '../src/shops.js'

export function fundCurrentCombatActors(tables, state, { heroes = [107002], pet = false } = {}) {
    for (const id of heroes) {
        assert.equal(tables.find('hero', id)?.isUsable, 1)
        if (!state.player.heros_info.heros.some((h) => h.conf_id === id && !h.trail))
            grantRewards(tables, state, [{ itemtype: 1, itemid: id, itemnum: 1 }])
    }
    if (pet && !state.pets.length) grantRewards(tables, state, [{ itemtype: 5, itemid: 500001, itemnum: 1 }])
    refreshBattleState(tables, state)
}
export function qualifyCurrentCombatWorld(tables, state) {
    // Explicit independent post-tutorial save qualification, not battle facts.
    const done = new Set(),
        levels = []
    const visit = (id) => {
        if (done.has(id)) return
        done.add(id)
        const row = tables.find('task', id)
        assert(row)
        for (const part of String(row.unlockcondition).split('|')) {
            const [kind, target] = part.split('#').map(Number)
            if (kind === 2007) visit(target)
            if (kind === 2004) levels.push(target)
        }
    }
    visit(106010)
    state.tasks = []
    state.taskRecords = [...done].map((task_id) => ({ task_id, count: 1, time: 1 }))
    state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
    delete state.pendingTaskScene
    delete state.pendingTaskStorySync
    Object.assign(state.world, tables.position(tables.find('world_borthpos', 10045)))
}
export function currentFixedGroup(tables, state, { minHp = 1, minSlots = 1 } = {}) {
    for (const row of tables.get('worldmap_100')) {
        if (tables.find('world_spawner', row.spawnerId)?.objectType !== 50 || row.appearCond || row.disappearCond)
            continue
        const group = tables.find('world_enemy_group', row.expandId),
            packs = String(group?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
                .map(Number)
        if (
            packs.length < minSlots ||
            group.displayCount < packs.length ||
            packs.some((id) => tables.find('enemy_pack', id)?.ECampType === 2)
        )
            continue
        const ids = packs.map((_, i) => ((3n << 56n) | (BigInt(i) << 32n) | BigInt(row.id)).toString()),
            definitions = ids.map((id) => enemyDefinition(tables, state, id))
        if (definitions.every((r) => r && r.max_hp > minHp)) return { row, group, packs, ids, definitions }
    }
    assert.fail('current unconditional fixed-world group with complete properties is required')
}
export function currentCombatSeasonNow(tables) {
    const rows = tables.get('battle_pass')
    assert.equal(rows.length, 1)
    const start = configTime(rows[0].startTime),
        end = configTime(rows[0].endTime)
    assert(start && end > start + 60)
    return start + 60
}

export function qualifyCurrentEntrust(tables, state, id) {
    qualifyCurrentCombatWorld(tables, state)
    // A complete fresh allocator, never the old fixture's records-only object.
    state.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
    const visited = new Set()
    const visit = (current) => {
        if (visited.has(current)) return
        visited.add(current)
        const row = tables.find('dungeon_entrust', current)
        assert(row)
        for (const term of String(row.taskUnlock ?? '')
            .split('|')
            .filter(Boolean)) {
            const [kind, target, stars] = term.split('#').map(Number)
            if (kind === 13044) {
                const previous = tables.find('dungeon_entrust', target)
                assert(previous)
                state.entrust.records[target] = { entrust_id: target, entrust_star: stars, group_id: previous.groupId }
                visit(target)
            } else if (kind === 2004) state.player.basic_info.lv = Math.max(state.player.basic_info.lv, target)
            else if (kind === 2007) {
                if (!state.taskRecords.some((r) => r.task_id === target))
                    state.taskRecords.push({ task_id: target, count: 1, time: 1 })
            } else assert.fail('Unsupported explicit entrust prerequisite ' + term)
        }
    }
    visit(id)
}
