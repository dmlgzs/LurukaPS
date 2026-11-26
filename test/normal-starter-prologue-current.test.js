import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-prologue-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ createNormalStarterFixture }, { TaskGraphs, asList }, { taskEnemyPacks }, { enemyDefinition }] =
    await Promise.all([
        import('./normal-starter-current-fixture.js'),
        import('../src/tasks.js'),
        import('../src/task-enemy-slots.js'),
        import('../src/enemy-state.js'),
    ])

test('normal formal106001 first battle uses an admitted current Trial1 actor and real millisecond HP death before task callbacks', () => {
    const f = createNormalStarterFixture('normal-formal106001-first-battle', {
        starterProfile: 'normal',
        traceDirectory: path.join(artifacts, 'trace'),
    })
    try {
        f.login()
        const permanent = f.state().player.heros_info.heros
        assert.equal(permanent.length, 1)
        assert.equal(f.currentGroup().id, 1)
        const task = f.state().tasks.find((row) => row.task_id === 106001)
        assert(
            task?.nodes.some((row) => row.node_id === 5),
            'genuine new-account accepted checkpoint, not a seeded task',
        )
        // prepareTaskScenes owns the configured initial scene. The actual
        // client entry/loading calls confirm that scene; never edit world102.
        assert.equal(f.state().world.map_id, 102)
        f.call('EnterWorldMap', { map_id: f.state().world.map_id })
        f.call('MapLoadFinish')
        f.call('TrialGroupChange', { open: true, trial_id: 1 })
        assert.equal(f.state().trialGroup.current_group_id, 1)
        assert.equal(f.currentGroup().id, 0)
        const attacker = f.currentGroup().control
        const trial = f.state().trialGroup.heroes.find((row) => row.guid === attacker)
        assert(trial && trial.conf_id === 107001)
        assert.equal(BigInt(attacker) >> 56n, 5n)
        assert.deepEqual(f.state().player.heros_info.heros, permanent)
        const q = { task_id: 106001, node_id: 5 }
        f.call('MultiTaskClientBefore', { task_params: [q] })
        const graph = new TaskGraphs(f.tables).get(106001)
        const condition = asList(graph.nodes.get(5).__type_TaskConditionNodeData.conditionList)[0]
        const data = condition.__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData
        const overrides = asList(data.enemiesDatas)
        const enemies = overrides.flatMap((row) =>
            taskEnemyPacks(f.tables, row).map((_, slot) =>
                ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(row.createNpcId)).toString(),
            ),
        )
        assert(enemies.length > 0)
        for (const id of enemies) {
            const definition = enemyDefinition(f.tables, f.state(), id)
            assert(definition?.max_hp > 1)
            const before = f.state().combat.entities[id]?.hp ?? definition.max_hp
            f.advanceMs(2)
            f.call('BattleInfoReduce', {
                base_time: String(f.nowMs()),
                uint64_dic: [attacker, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
            })
            assert.equal(f.state().combat.entities[id]?.hp, before - 1, 'accepted real partial HP damage')
            f.advanceMs(2)
            const hp = f.state().combat.entities[id].hp
            f.call('BattleInfoReduce', {
                base_time: String(f.nowMs()),
                uint64_dic: [attacker, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
            })
            assert.equal(f.state().combat.entities[id]?.hp, 0)
            assert.equal(f.state().combat.entities[id]?.alive_state, 1)
        }
        for (const row of overrides)
            f.call('ClientBehaviourRecord', { key: 2520, args: [data.createNpcId, 106001, 5, 0, 1] })
        f.call('MultiTaskClientCondAfter', { task_params: [{ ...q, indexes: [0] }] })
        f.call('MultiTaskClientAfter', { task_params: [q] })
        assert(
            f
                .state()
                .tasks.find((row) => row.task_id === 106001)
                .nodes.some((row) => row.node_id === 61),
        )
        assert.equal(f.state().player.heros_info.heros.length, 1)
        assert.deepEqual(f.state().pets, [])
        assert.deepEqual(f.state().recordPets ?? [], [])
        assert(
            !Object.hasOwn(f.state().heroAcquisitionCounts ?? {}, 107001),
            'temporary combat actor was not permanently granted',
        )
    } finally {
        f.close()
    }
})
