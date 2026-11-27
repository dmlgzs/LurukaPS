// Frozen V14 actual301-request prerequisite; no test registration or seeded checkpoint.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const artifacts =
    process.env.NORMAL_PROGRESSION_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-progression-'))
fs.mkdirSync(artifacts, { recursive: true })
console.log('[normal-progression-artifacts] ' + artifacts)
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [
    { createNormalStarterFixture },
    { reachNormalFirstPet },
    { nodeConditions, conditionValue },
    { taskActions },
    { normalProgressionFlow },
    { captureCurrentWorldPet },
] = await Promise.all([
    import('./prefix-correction-fixture.js'),
    import('./prefix-correction-first-pet.js'),
    import('../src/tasks.js'),
    import('../src/task-scenes.js'),
    import('./prefix-correction-progress-flow.js'),
    import('./prefix-correction-capture.js'),
])

export function reachNormal167() {
    const f = createNormalStarterFixture('normal-progression-current', { traceDirectory: artifacts })
    const visits = []
    const unlocks = [],
        captures = []
    const wire = [],
        pointNotifications = []
    let clientLocked = new Set()
    const consume = (packets) => {
        for (const packet of packets) {
            const descriptor = f.protocol.byId.get(packet.id)
            const decoded = f.protocol.decode(descriptor.rsp, packet.payload)
            const basic =
                packet.id === 5001 ? decoded.data?.basic_info : packet.id === 5008 ? decoded.basic_info : undefined
            if (basic) clientLocked = new Set(basic.lock_system ?? [])
            if (descriptor.name === 'CSProtoUnLockSync') {
                for (const id of decoded.unlock_id) clientLocked.delete(id)
                unlocks.push(...decoded.unlock_id)
            }
            if (descriptor.name === 'CSProtoWorldMapPointSync') pointNotifications.push(...decoded.u32s)
            wire.push({
                id: packet.id,
                name: descriptor.name,
                ...(basic ? { locked101: clientLocked.has(101), locked151: clientLocked.has(151) } : {}),
                ...(descriptor.name === 'CSProtoUnLockSync' ? { unlockIds: decoded.unlock_id } : {}),
                ...(descriptor.name === 'CSProtoWorldMapPointSync' ? { points: decoded.u32s } : {}),
            })
        }
    }
    let transferred = false
    try {
        const driver = reachNormalFirstPet(f, consume)
        const { graphs, call, perform } = driver
        const taskId = 106002
        const task = f.state().tasks.find((row) => row.task_id === taskId)
        assert.deepEqual(
            task.nodes.map((row) => row.node_id),
            [65],
        )
        const node = graphs.get(taskId).nodes.get(65)
        visits.push({ taskId, nodeId: node.id })
        perform(taskId, node, 'before')
        call('MultiTaskClientBefore', { task_params: [{ task_id: taskId, node_id: node.id }] })
        assert.equal(nodeConditions(node)[0].conditionId, 2508)
        // Current TaskCondOpenPageData(pageGetPet,isCloseOver=true): a bounded
        // local page-close model. It reports the actual scoped callback and
        // does not create task records or claim Unity rendering was exercised.
        call('ClientBehaviourRecord', { key: 2508, args: [taskId, 1] })
        call('MultiTaskClientCondAfter', { task_params: [{ task_id: taskId, node_id: node.id, indexes: [0] }] })
        perform(taskId, node, 'after')
        call('MultiTaskClientAfter', { task_params: [{ task_id: taskId, node_id: node.id }] })
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === taskId)
                .nodes.map((row) => row.node_id),
            [61],
        )
        const equipNode = graphs.get(taskId).nodes.get(61)
        visits.push({ taskId, nodeId: equipNode.id })
        for (const action of taskActions(equipNode, 'before')) {
            if (action.__type_TaskOpenStoryData) driver.playStory(action.__type_TaskOpenStoryData.storyId)
            else if (action.__type_TaskEquipPetData) {
                const data = action.__type_TaskEquipPetData
                const slot = f.currentGroup().heros[data.teamIndex]
                const pet = f.state().pets.find((row) => row.config_id === data.petConfigId)
                assert(slot?.hero_id && pet)
                const request = { hero_guid: slot.hero_id, pet_guid: pet.guid }
                fs.writeFileSync(
                    path.join(artifacts, 'equip-request.json'),
                    JSON.stringify(
                        {
                            source: 'TaskEntityEquipPet.Execute0602e3f7 -> GetHeroByFormationPosIndex -> ReqWearPet06029ad4',
                            taskId,
                            nodeId: equipNode.id,
                            data,
                            request,
                            activeGroup: f.currentGroup(),
                            ownedHeroes: f
                                .state()
                                .player.heros_info.heros.map(({ guid, conf_id }) => ({ guid, conf_id })),
                            temporaryHeroes: f.state().temporaryHeroes,
                        },
                        null,
                        2,
                    ) + '\n',
                )
                call('WearPet', request)
            } else assert(action.__type_TaskSetLookAtData, 'unmodelled equip-node action')
        }
        const equipRequest = { task_id: taskId, node_id: equipNode.id }
        call('MultiTaskClientBefore', { task_params: [equipRequest] })
        const trigger = nodeConditions(equipNode)[0].__type_TaskConditionBaseData.__type_TaskCondActiveNPCTriggerData
        assert(trigger?.isNowCreate)
        driver.move({ x: trigger.npcData.posX, y: trigger.npcData.posY, z: trigger.npcData.posZ })
        call('ClientBehaviourRecord', { key: 2519, args: [trigger.npcData.createNpcId, taskId, equipNode.id, 0, 1] })
        call('MultiTaskClientCondAfter', { task_params: [{ ...equipRequest, indexes: [0] }] })
        perform(taskId, equipNode, 'after')
        call('MultiTaskClientAfter', { task_params: [equipRequest] })
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === taskId)
                .nodes.map((row) => row.node_id),
            [58],
        )
        const puzzleModel = []
        const flow = normalProgressionFlow(f, driver, {
            objectCompletion(data, { world, move, call }) {
                assert.equal(data.sceneId, 102)
                assert([300003, 300000].includes(data.npcId))
                assert.equal(data.status, 1)
                const { row, spawner, pos } = world.object(data.sceneId, data.npcId)
                const bp = f.tables.find('world_blueprint', row.blueprint || spawner.blueprint)
                let ext_context, graphSha256, localInputs
                if (data.npcId === 300003) {
                    assert.equal(spawner.objectType, 161)
                    assert.equal(bp.path, 'Config/World/Graph/Blueprint/ast_level_pet_puzzle_area.asset')
                    assert.equal(bp.param, 'puzzleAttrs#4|DelayTime#0')
                    const equipped = f
                        .state()
                        .pets.filter(
                            (pet) =>
                                pet.hero_id !== '0' &&
                                f
                                    .state()
                                    .player.heros_info.heros.some(
                                        (hero) => hero.guid === pet.hero_id && hero.pet_id === pet.guid,
                                    ),
                        )
                    assert.equal(equipped.length, 1)
                    const pet = equipped[0]
                    assert.equal(pet.config_id, 500297)
                    assert(String(f.tables.find('pet', pet.config_id).element).split('|').map(Number).includes(4))
                    graphSha256 = 'f8f48ac434f3b265a45ab7618b9e3042cf2ed20542dc63a01947913e7ccdb7ed'
                    localInputs = ['actual-equipped-pet-element4-hit-success', 'PuzzlePerform.fire-complete']
                    ext_context = { ext_type: 1, ext_uint32_1: 4, ext_uint64_1: pet.guid }
                } else {
                    assert.equal(spawner.objectType, 34)
                    assert.equal(bp.path, 'Config/World/Graph/Blueprint/ast_common_treasure_chest.asset')
                    graphSha256 = 'd08123675158cacf2d269de5107021f077b4831eecaa35581ede1fd8009dfb84'
                    localInputs = ['actual-entity-interact39-button-complete']
                }
                move(pos)
                // Current ResultRewardUpload sends this after the explicitly
                // modelled local success. No fabricated Skill/Hurt/task write.
                const input = {
                    obj: { obj_id: row.id, complete: true, state_data: {}, pos },
                    pos,
                    interact_id: 0,
                    interact_type: 0,
                    ...(ext_context ? { ext_context } : {}),
                }
                puzzleModel.push({ graphSha256, localInputs, input })
                call('WorldObjInteract', { objs: [input] })
                assert.equal(f.state().worldObjects[`${data.sceneId}:${data.npcId}`].complete, true)
            },
            afterSourceAction(kind, data, { call }) {
                if (kind === 'TaskActiveBehaviorData') {
                    // TaskHelper.SendActiveBehavior0602f1d1 writes literal3.
                    call('WorldMapActiveBehavior', { type: 3 })
                    return true
                }
                if (kind === 'TaskChangeTeamMain') {
                    const heroes = [...f.state().player.heros_info.heros, ...(f.state().trialGroup?.heroes ?? [])]
                    const actor = heroes.find((row) => row.guid === f.currentGroup().control)
                    // SwitchFormationMainControlIndex06029ef4 returns without
                    // RPC when this requested formation index is already active.
                    assert.equal(actor?.conf_id, data.mainId)
                    return true
                }
                return false
            },
            playableCompletion(data, { call, taskId }) {
                assert.equal(data.playableId, 60001)
                const config = f.tables.find('playable', data.playableId)
                assert.equal(config.stepMax, 10)
                assert.equal(config.stepRewards, '1#16005|2#16004|3#16006')
                const before = f.state().pets.length
                // Explicit local player choice1 from the CURRENT table; the
                // real stage grant/choice receipt decides owned pet and branch.
                call('PlayableStart', { u32: data.playableId })
                call('PlayableStep', { playId: data.playableId, is_step: true, finish_step: 1 })
                assert.equal(f.state().pets.length, before + 1)
                assert.equal(f.state().taskPetChoices[taskId], 1)
                call('PlayableStep', { playId: data.playableId, is_step: true, finish_step: config.stepMax })
                call('PlayableFinish', { playId: data.playableId, index: 0, score: 0 })
                assert.equal(f.state().playableFinishes[data.playableId].map_id, f.state().world.map_id)
            },
            guidedCompletion(condition, context) {
                const { node, world, taskId, index } = context
                assert.equal(taskId, 106010)
                assert.equal(conditionValue(condition, f.state(), { taskId, nodeId: node.id, index }), 0)
                if (node.id === 184 || node.id === 185) {
                    captures.push(
                        captureCurrentWorldPet(
                            f,
                            driver,
                            world,
                            node.id === 184 ? { objectId: 201072, petGroup: 49 } : { objectId: 201073, petGroup: 19 },
                        ),
                    )
                } else if (node.id === 153) {
                    assert(!f.state().player.basic_info.lock_system.includes(151))
                    assert(!f.state().world.points.includes(10050))
                    const { row, spawner, pos } = world.object(100, 200128)
                    assert.equal(spawner.objectType, 21)
                    const options = f.tables.get('world_interact').filter((value) => value.interactAction === 13)
                    assert.equal(options.length, 1)
                    const height = f.tables.find('world_item', spawner.resourceId)?.rewardHeight ?? 0
                    const rewardPos = { ...pos, y: pos.y + Math.round(height * 100) }
                    driver.move(pos)
                    const request = {
                        objs: [
                            {
                                obj: { obj_id: row.id, complete: true, state_data: {}, pos: rewardPos },
                                pos: rewardPos,
                                interact_id: options[0].id,
                                interact_type: 0,
                                tool_type: 0,
                                tool_cfg_id: 0,
                                element_id: 0,
                                drop_type: 0,
                            },
                        ],
                    }
                    call('WorldObjInteract', request)
                    assert(f.state().world.points.includes(10050))
                    call('WorldObjInteract', request)
                    assert.equal(f.state().world.points.filter((id) => id === 10050).length, 1)
                } else assert.fail('Unmodelled current guided condition at node' + node.id)
                assert(conditionValue(condition, f.state(), { taskId, nodeId: node.id, index }) > 0)
            },
        })
        flow.step(106002)
        flow.step(106002)
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === taskId)
                .nodes.map((row) => row.node_id),
            [62],
        )
        for (let count = 0; f.state().tasks.some((row) => row.task_id === 106002); count++) {
            assert(count < 8, 'bounded remaining106002 graph')
            flow.step(106002)
        }
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106002).count, 1)
        assert(f.state().tasks.some((row) => row.task_id === 106009))
        for (let count = 0; f.state().tasks.some((row) => row.task_id === 106009); count++) {
            assert(count < 10, 'bounded current106009 graph')
            flow.step(106009)
        }
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106009).count, 1)
        assert(f.state().tasks.some((row) => row.task_id === 106010))
        for (let count = 0; f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id !== 168; count++) {
            assert(count < 18, 'bounded current choice route before168')
            flow.step(106010)
        }
        const before168 = driver.cards()
        flow.step(106010)
        assert.equal(driver.cards(), before168 + 10, 'real current node168 rewards10 capture cards')
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === 106010)
                .nodes.map((row) => row.node_id),
            [184],
        )
        assert(f.state().player.basic_info.lock_system.includes(151))
        assert(f.state().player.basic_info.lock_system.includes(101))
        for (let count = 0; f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id !== 177; count++) {
            assert(count < 8, 'bounded184/185/153/177/156 route')
            flow.step(106010)
        }
        assert.equal(captures.length, 2)
        assert(unlocks.includes(151))
        assert(!unlocks.includes(101), 'System101 must wait for genuine node156')
        assert(f.state().player.basic_info.lock_system.includes(101))
        assert(clientLocked.has(101))
        flow.step(106010) //177: real outer NPC106010005 + current type0 story
        assert.equal(f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id, 156)
        assert(clientLocked.has(101))
        const start156 = wire.length
        flow.step(106010) //156: current type1 NPC dialogue, then true task ACKs
        assert.equal(f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id, 167)
        const finish156Packets = wire.slice(start156)
        const unlock101Index = finish156Packets.findIndex((row) => row.unlockIds?.includes(101))
        assert(unlock101Index >= 0)
        assert.equal(unlock101Index, finish156Packets.length - 1, '10600 follows all same-request fact packets')
        assert(
            finish156Packets.slice(0, unlock101Index).some((row) => row.id === 5008 && row.locked101 === true),
            'same-step5008 still carries old lock list before10600',
        )
        assert(!clientLocked.has(101))
        assert(!f.state().player.basic_info.lock_system.includes(101))
        assert(f.game.systemUnlocks.inspect(f.state()).unlocked.includes(101))
        assert.equal(unlocks.filter((id) => id === 101).length, 1)
        const index151 = wire.findIndex((row) => row.unlockIds?.includes(151))
        const indexPoint = wire.findIndex((row) => row.points?.includes(10050))
        const index101 = wire.findIndex((row) => row.unlockIds?.includes(101))
        assert(index151 >= 0 && indexPoint > index151 && index101 > indexPoint)
        const stable = {
            pets: f.state().pets.map((pet) => pet.guid),
            points: [...f.state().world.points],
            cards: driver.cards(),
        }
        consume(f.coldLogin())
        assert.deepEqual(
            f.state().pets.map((pet) => pet.guid),
            stable.pets,
        )
        assert.deepEqual(f.state().world.points, stable.points)
        assert.equal(driver.cards(), stable.cards)
        assert(!f.state().player.basic_info.lock_system.includes(101))
        assert(!clientLocked.has(101))
        assert(!clientLocked.has(151))
        assert(f.game.systemUnlocks.inspect(f.state()).unlocked.includes(101))
        assert(pointNotifications.includes(10050))
        fs.writeFileSync(
            path.join(artifacts, 'capture-system.json'),
            JSON.stringify({ captures, unlocks, pointNotifications, wire, stable }, null, 2) + '\n',
        )
        fs.writeFileSync(path.join(artifacts, 'puzzle-model.json'), JSON.stringify(puzzleModel, null, 2) + '\n')
        fs.writeFileSync(
            path.join(artifacts, 'progression.json'),
            JSON.stringify(
                { visits: [...visits, ...flow.visits], actions: flow.actions, summary: f.summary() },
                null,
                2,
            ) + '\n',
        )
        transferred = true
        return { f, driver, flow, consume, wire, unlocks, captures, artifacts }
    } finally {
        fs.writeFileSync(path.join(artifacts, 'progression-tail.json'), JSON.stringify(f.summary(), null, 2) + '\n')
        if (!transferred) f.close()
    }
}
