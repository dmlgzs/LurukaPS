import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The optional continuation runs inside the same guarded try/finally and RAM context.
export async function runCurrentSunyaMilestone({ artifacts, continuePlayableCompletion, afterMilestone } = {}) {
    artifacts ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-next106013-runner-'))
    fs.mkdirSync(artifacts, { recursive: true })
    process.env.NORMAL_106012_ARTIFACTS = artifacts
    process.env.NORMAL_SUCCESSOR_ARTIFACTS = artifacts
    process.env.NORMAL_PROGRESSION_ARTIFACTS = artifacts
    process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
    process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
    const [
        { reachCurrent106013 },
        { normalSuccessorFlow },
        { WorldObjectCatalog },
        { worldCondition },
        { enemyDefinition },
        { observeCurrentDispatch },
    ] = await Promise.all([
        import('./next106013-prerequisite.js'),
        import('./prefix-correction-flow.js'),
        import('../src/world-objects.js'),
        import('../src/handlers/world-objects.js'),
        import('../src/enemy-state.js'),
        import('./next106013-dispatch-trace.js'),
    ])

    const observer = observeCurrentDispatch()
    let context
    try {
        context = reachCurrent106013()
    } catch (error) {
        observer.restore()
        fs.writeFileSync(path.join(artifacts, 'all-dispatch.json'), JSON.stringify(observer.trace, null, 2) + '\n')
        throw error
    }
    const { f, driver } = context
    const prefixRequests = f.requestCount(),
        stories = [],
        playables = []
    const profiles = new Map([
        [101053, { type: 0, tag: 0, clicks: 1, choice: { dialog: 10105302, optionIndex: 0, terminal: 42 } }],
        [5101109, { type: 2, tag: 0, clicks: 0 }],
        [101082, { type: 0, tag: 0, clicks: 1, choice: { dialog: 10108203, optionIndex: 0, terminal: 19 } }],
        [101084, { type: 2, tag: 0, clicks: 0 }],
        [101085, { type: 0, tag: 0, clicks: 0, terminal: 3 }],
        [10108502, { type: 0, tag: 0, clicks: 0, terminal: 4 }],
        [5101130, { type: 2, tag: 0, clicks: 0 }],
        [101056, { type: 0, tag: 0, clicks: 0, terminal: 14 }],
        [101057, { type: 2, tag: 0, clicks: 0 }],
        [101055, { type: 3, tag: 0, clicks: 0, terminal: 1 }],
    ])
    const playStory = (id, beforeWatch) => {
        const profile = profiles.get(id)
        assert(profile, 'Current106013 story source not recovered: ' + id)
        assert.equal(f.tables.find('story', id).storyType, profile.type)
        // Explicit local full-play/choice completion has occurred. Current
        // RuntimeStoryEnd invokes the end callback before serializing6060.
        beforeWatch?.()
        driver.call('SetStoryId', {
            story_id: id,
            story_type: profile.type,
            tag: profile.tag,
            param: profile.clicks,
            is_skip: false,
        })
        stories.push({ id, ...profile, localAutomaticCompletion: true, nativePlayback: false })
    }
    const flow = normalSuccessorFlow(
        f,
        { ...driver, playStory },
        {
            npcStoryCompletion: (data) => playStory(data.storyId),
            playableCompletion(data, { taskId, node, index, call }) {
                if (data.playableId !== 62015) {
                    assert(continuePlayableCompletion, 'Current next playable source required')
                    return continuePlayableCompletion(data, {
                        f,
                        driver,
                        playStory,
                        playables,
                        taskId,
                        node,
                        index,
                        call,
                    })
                }
                const origin = { x: data.playableData.posX, y: data.playableData.posY, z: data.playableData.posZ }
                driver.move(origin)
                const packets = call('WorldObjEnemyInfo', { obj_id: 0, play_id: 62015 })
                const info = driver.reply('WorldObjEnemyInfo', packets).monster_info.monsters
                const waves = [
                    { index: 0, tag: 'monster_1', group: 100012 },
                    { index: 1, tag: 'monster_2', group: 100010 },
                ]
                // Current TaskPlayableObject.CreateUnit uses worldmap0;
                // CheckReqMonsterUuids06008b7a sends9136 before local creation.
                call('PlayableStart', { u32: 62015 }) // local first group entered battle
                const damage = (target, delta) => {
                    f.advanceMs(2)
                    call('BattleInfoReduce', {
                        base_time: String(f.nowMs()),
                        uint64_dic: [f.currentGroup().control, target],
                        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
                    })
                }
                const proof = []
                for (const wave of waves) {
                    if (wave.index === 1) {
                        f.advanceMs(2000)
                        playStory(101084)
                    }
                    const packs = String(f.tables.find('world_enemy_group', wave.group).enemyList)
                        .split('|')
                        .map(Number)
                    const monsters = info.filter((row) => row.index === wave.index)
                    assert.equal(monsters.length, packs.length)
                    for (const monster of monsters) {
                        assert.equal(monster.enemy_group, wave.group)
                        const definition = enemyDefinition(f.tables, f.state(), monster.uuid)
                        const slot = Number((BigInt(monster.uuid) >> 32n) & 0xffffffn)
                        assert.equal(definition.pack_id, packs[slot])
                        const hp = f.state().combat?.entities?.[monster.uuid]?.hp ?? definition.max_hp
                        assert(hp > 1)
                        damage(monster.uuid, -1)
                        assert.equal(f.state().combat.entities[monster.uuid].hp, hp - 1)
                        damage(monster.uuid, -(hp - 1))
                        assert.equal(f.state().combat.entities[monster.uuid].hp, 0)
                    }
                    proof.push({ ...wave, monsters: monsters.map((row) => row.uuid), packs })
                }
                // Current noChest true, endStory101085. End callback starts
                // purification timeline and sends step4 before6060; local
                // timeline completion then no-chest helper sends terminal10.
                playStory(101085, () =>
                    call('PlayableStep', { playId: 62015, is_step: true, finish_step: 4, pos: origin }),
                )
                call('PlayableStep', { playId: 62015, is_step: true, finish_step: 10, pos: origin })
                const finishPackets = call('PlayableFinish', { playId: 62015, score: 0, pos: { x: 0, y: 0, z: 0 } })
                assert.equal(f.state().playableFinishes[62015].map_id, 100)
                // Current Base.IsComplate consumes synchronized nodeValues;
                // CompletePlayable.Complate only cleans up. Do not call the
                // unconnected legacy SuccessCallBack notification manually.
                const taskSync = finishPackets
                    .filter((packet) => packet.id === 9853)
                    .flatMap((packet) => f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload).tasks)
                    .find((task) => task.task_id === taskId)
                assert(taskSync, '9404 must publish current TaskSync before condition-after ACK')
                const syncedNode = taskSync.nodes.find((value) => value.node_id === node.id)
                assert(syncedNode?.node_values[index] >= 1, 'current Native completion consumes real9853 nodeValues')
                playables.push({
                    id: 62015,
                    blueprint: 300605,
                    waves: proof,
                    inactiveTagNotKilled: 'monster_3',
                    localInputs: [
                        'enter-first-group-battle',
                        'wave-clear-on-actual-all-HP0',
                        'current-end-story',
                        'purification-timeline-complete',
                    ],
                    noChest: true,
                    stepSequence: [4, 10],
                    completionTaskSync: { taskId, nodeId: node.id, index, nodeValues: syncedNode.node_values },
                    unityPhysics: false,
                })
            },
        },
    )
    let closed = false
    const close = () => {
        if (closed) return
        closed = true
        try {
            observer.restore()
            fs.writeFileSync(path.join(artifacts, 'all-dispatch.json'), JSON.stringify(observer.trace, null, 2) + '\n')
            fs.writeFileSync(
                path.join(artifacts, 'next106013.json'),
                JSON.stringify(
                    {
                        boundary:
                            'actual combined561 prerequisite and current local story/choice model; no GM, checkpoint or prewritten ownership/level/task facts',
                        prefixRequests,
                        newRequests: f.requestCount() - prefixRequests,
                        visits: flow.visits,
                        stories,
                        playables,
                        final: f.summary(),
                    },
                    null,
                    2,
                ) + '\n',
            )
        } finally {
            f.close()
        }
    }
    try {
        assert.equal(prefixRequests, 561, 'combined519+42 must actually execute in this same Store')
        assert.equal(f.state().tasks.find((row) => row.task_id === 106013).nodes[0].node_id, 3)
        flow.step(106013)
        assert.equal(f.state().tasks.find((row) => row.task_id === 106013).nodes[0].node_id, 32)
        assert.deepEqual(
            stories.map(({ id }) => id),
            [101053, 5101109],
        )
        const world = new WorldObjectCatalog(f.tables)
        const { row, spawner, pos } = world.object(200, 200002)
        assert.equal(spawner.objectType, 303)
        assert(worldCondition(row.appearCond, f.state()))
        assert.equal(row.interactOverrideParams, '10#10045')
        assert.equal(f.tables.find('world_borthpos', 10045).cityId, 100)
        driver.move(pos)
        driver.call('EnterWorldMap', { map_id: 100, point_id: 10045, creator_id: f.state().player.basic_info.id })
        driver.call('MapLoadFinish')
        flow.step(106013)
        assert.equal(f.state().tasks.find((task) => task.task_id === 106013).nodes[0].node_id, 23)
        flow.step(106013)
        assert.equal(f.state().tasks.find((task) => task.task_id === 106013).nodes[0].node_id, 4)
        for (let count = 0; f.state().tasks.find((task) => task.task_id === 106013).nodes[0].node_id !== 6; count++) {
            assert(count < 13, 'bounded current NPC path to memory62026')
            flow.step(106013)
        }
        assert.equal(
            observer.trace.length,
            f.requestCount(),
            'full observer must cover exactly this fixture dispatch stream',
        )
        assert.deepEqual(
            flow.visits.map((row) => row.nodeId),
            [3, 32, 23, 4, 5, 24, 25, 26, 27, 28, 29, 30, 31],
        )
        assert.equal(f.state().world.map_id, 100)
        assert.deepEqual(
            f
                .state()
                .tasks.find((task) => task.task_id === 106013)
                .nodes.map((row) => row.node_id),
            [6],
        )
        const expected = [101053, 5101109, 101082, 101084, 101085, 10108502, 5101130, 101056, 101057, 101055]
        assert.deepEqual(
            stories.map((row) => row.id),
            expected,
        )
        const reports = observer.trace.slice(prefixRequests).filter((row) => row.id === 6060)
        const playableNotifies = observer.trace
            .slice(prefixRequests)
            .filter((row) => row.id === 9904 && row.request.key === 2525)
        assert.equal(playableNotifies.length, 0, 'modern playable completion consumes9853, no artificial2525')
        assert.deepEqual(
            reports.map((row) => [
                row.request.story_id,
                row.request.story_type,
                row.request.tag,
                row.request.param,
                row.request.is_skip,
            ]),
            expected.map((id) => {
                const p = profiles.get(id)
                return [id, p.type, p.tag, p.clicks, false]
            }),
        )

        fs.writeFileSync(
            path.join(artifacts, 'sunya-prefix-dispatch.json'),
            JSON.stringify(observer.trace, null, 2) + '\n',
        )
        afterMilestone?.({ f, driver, flow, observer, prefixRequests, stories, playables })
    } finally {
        close()
    }
}
