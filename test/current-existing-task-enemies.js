import assert from 'node:assert/strict'
import { taskOverrideNodeIds } from '../src/task-action-data.js'
import { asList } from '../src/tasks.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { enemyDefinition } from '../src/enemy-state.js'

// Source-qualified successful hits and final removal callbacks. This does
// not execute enemy AI or infer damage from a client skill animation.
export function currentExistingTaskEnemyGroup(f, driver, data, { taskId, node }, events) {
    assert(data.useExistEnemy && data.createNpcId > 0)
    const groups = driver.graphs
        .get(taskId)
        .controllers.filter((controller) => taskOverrideNodeIds(controller).includes(node.id))
        .flatMap((controller) => asList(controller.__type_TaskCreateBattleUnitDataController?.enemiesDatas))
        .filter((group) => group.createNpcId === data.createNpcId && group.sceneId === f.state().world.map_id)
    assert.equal(groups.length, 1, 'Unique current scoped existing group required')
    const group = groups[0]
    const override = group.__type_TaskEnemiesOverrideData
    assert(override.useInlineEnemySlots && override.enemySlots.length > 0)
    const packs = taskEnemyPacks(f.tables, group)
    assert.equal(packs.length, override.enemySlots.length)
    assert.equal(override.corpseTime, 0)
    driver.move({ x: group.posX, y: group.posY, z: group.posZ })
    if (override.battlePreStoryId > 0) {
        const rows = f.tables.get('story_convenient').filter((row) => row.story_id === override.battlePreStoryId)
        assert.equal(f.tables.find('story', override.battlePreStoryId)?.storyType, 2)
        assert(
            rows.length &&
                rows.every(
                    (row) =>
                        row.type_callback === 0 && row.tag_id === 0 && [1, 2, 3, 4, 5].every((n) => !row['Option' + n]),
                ),
        )
        assert.equal(override.needStoryDoneThenBattle, false)
        // Complete the nonblocking convenience dialogue before hit inputs;
        // it is not an invented global1004 record or a wait requirement.
        driver.call('SetStoryId', {
            story_id: override.battlePreStoryId,
            story_type: 2,
            tag: 0,
            param: 0,
            is_skip: false,
        })
        events.push({ kind: 'existing-enemies-pre-story', id: override.battlePreStoryId })
    }
    const targets = []
    for (const [slot, pack] of packs.entries()) {
        const target = ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(group.createNpcId)).toString()
        const definition = enemyDefinition(f.tables, f.state(), target)
        assert.equal(definition.pack_id, pack)
        const hp = f.state().combat?.entities?.[target]?.hp ?? definition.max_hp
        assert(hp > 1, 'A genuine current live enemy is required')
        for (const amount of [1, hp - 1]) {
            f.advanceMs(2)
            driver.call('BattleInfoReduce', {
                base_time: String(f.nowMs()),
                uint64_dic: [f.currentGroup().control, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -amount } }],
            })
        }
        assert.equal(f.state().combat.entities[target].hp, 0)
        targets.push({ target, pack, slot, initialHp: hp })
    }
    // TaskEntityEnemiesGroup0602e642/643 checks the existing group,waits
    // for matching ETaskEvent2039 and reports its actual2519 through0602e646.
    // The caller emits that report only after these successful local removals.
    events.push({
        kind: 'existing-enemies-all-removed-input',
        taskId,
        node: node.id,
        group: group.createNpcId,
        targets,
    })
}
