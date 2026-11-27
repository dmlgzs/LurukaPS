import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { runCurrentHomeApproach } from './next106015-home-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { gridAnchor, buildingRect, validatePlacement, homeCondition } from '../src/home-grid.js'
import { guidedConditionValue } from '../src/guided-conditions.js'
import { taskSnapshot } from '../src/tasks.js'
import { taskOverrideNodeIds } from '../src/task-action-data.js'
// Current-source successful input schedule; not Unity rendering or physics.
export async function runCurrentShadowChapter({ outputDirectory, afterChapter } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-shadow-chapter-'))
    fs.mkdirSync(directory, { recursive: true })
    let final
    await runCurrentHomeApproach({
        outputDirectory: directory,
        afterApproach({ f, driver, observer }) {
            const before = f.requestCount(),
                events = []
            const wireComplete = (packets, nodeId) =>
                packets
                    .filter((packet) => packet.id === 9853)
                    .flatMap((packet) => f.protocol.decode(f.protocol.byId.get(9853).rsp, packet.payload).tasks ?? [])
                    .filter((task) => task.task_id === 106015)
                    .flatMap((task) => task.nodes ?? [])
                    .some((node) => node.node_id === nodeId && node.node_values?.[0] >= 1)
            const bagCount = (id) =>
                f
                    .state()
                    .player.sbag_infos.items.filter((item) => item.itemtype === 3 && item.itemid === id)
                    .reduce((sum, item) => sum + item.itemnum, 0)
            const findPlace = (id) => {
                const current = f.state(),
                    size = buildingRect(f.tables, id, { anchor: gridAnchor(0, 0), direction: 0 })
                for (const block of f.tables
                    .get('home_block')
                    .filter(
                        (b) =>
                            b.blockType === 0 && [1, 2].includes(b.groupType) && homeCondition(b.unlockCondi, current),
                    )
                    .toSorted((a, b) => a.id - b.id)) {
                    const start = block.blockStartPos.split('|').map(Number),
                        end = block.blockEndPos.split('|').map(Number)
                    for (let x = Math.min(start[0], end[0]); x + size.w <= Math.max(start[0], end[0]); x++)
                        for (let y = Math.min(start[1], end[1]); y + size.h <= Math.max(start[1], end[1]); y++) {
                            const rect = { x, y, w: size.w, h: size.h }
                            if (
                                current.home.builds
                                    .filter((b) => b.locate?.block_id === block.id)
                                    .some((b) => {
                                        const r = buildingRect(f.tables, b.build_id, b.locate)
                                        return (
                                            rect.x < r.x + r.w &&
                                            rect.x + rect.w > r.x &&
                                            rect.y < r.y + r.h &&
                                            rect.y + rect.h > r.y
                                        )
                                    })
                            )
                                continue
                            const locate = { block_id: block.id, anchor: gridAnchor(x, y), direction: 0 }
                            validatePlacement(f.tables, current, id, locate)
                            return locate
                        }
                }
                assert.fail('No free current placement')
            }
            const buildHouse = () => {
                const recipe = f.tables.find('products', 710029)
                assert.equal(recipe.rewardId, '13#20171#1')
                assert(homeCondition(recipe.unlockCondition, f.state()))
                const station = f
                    .state()
                    .home.builds.find(
                        (b) =>
                            b.locate &&
                            String(recipe.group)
                                .split('|')
                                .map(Number)
                                .includes(f.tables.find('home_building_production', b.build_id)?.groupId),
                    )
                assert(station)
                const materialBefore = [bagCount(300000), bagCount(301000)]
                const pointsBefore =
                    f.state().player.attr_infos.attrs.find((item) => item.attr_id === 103)?.attr_val ?? '0'
                driver.call('HomeTechnologyFirstOpen', { type: 2, subType: 22010 })
                const oldJobs = new Set(
                    Object.values(f.state().home.productionJobs ?? {})
                        .flat()
                        .map((j) => j.guid),
                )
                driver.call('ProductStart', { build_guid: station.guid, product_id: recipe.id, count: 1 })
                assert.deepEqual([bagCount(300000), bagCount(301000)], [materialBefore[0] - 20, materialBefore[1] - 10])
                assert.equal(
                    f.state().player.attr_infos.attrs.find((item) => item.attr_id === 103)?.attr_val ?? '0',
                    pointsBefore,
                    'Current710029 material list does not charge historical1000 points',
                )
                const job = Object.values(f.state().home.productionJobs)
                    .flat()
                    .find((j) => !oldJobs.has(j.guid) && j.productId === recipe.id)
                assert(job)
                f.advanceMs(Math.max(0, (job.start + job.seconds) * 1000 - f.nowMs()) + 1000)
                driver.call('ProductFinish', { guid: station.guid, is_all: true })
                assert.equal(guidedConditionValue(10041, f.state()), 0, 'Crafting a card is not placing a building')
                const packets = driver.call('BuildLocate', { build_id: 20171, locate: findPlace(20171) })
                const reply = packets.find((p) => p.id === 6105)
                assert(reply)
                const house = f.protocol.decode(f.protocol.byId.get(6105).rsp, reply.payload)
                assert(wireComplete(packets, 62), 'BuildLocate must publish actual node62 progress')
                events.push({ kind: 'built-house', house: house.guid, job })
            }
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion: (d) => driver.playStory(d.storyId),
                timeCompletion(data, { taskId, node, index }) {
                    assert.equal(data.checkNameType, 2)
                    assert.equal(data.startTime, 6)
                    assert.equal(data.endTime, 18)
                    assert.equal(data.isJumpDay, true)
                    assert.equal(data.jumpDay, 1)
                    events.push({ kind: 'local-time-advance-input', registeredDay: 0, currentDay: 1, hour: 8 })
                    const packets = driver.call('ClientBehaviourRecord', {
                        key: 1100,
                        args: [taskId, node.id, index, 1],
                    })
                    assert(wireComplete(packets, node.id), 'Scoped timer must sync its completed value')
                },
                submitCompletion(data, { taskId, node, index }) {
                    assert.equal(data.npcType, 1, 'Current submission uses an existing task-created NPC')
                    const npc = driver.graphs
                        .get(taskId)
                        .npcs.find((n) => n.createNpcId === data.npcId && taskOverrideNodeIds(n).includes(node.id))
                    assert(npc, 'Current submission NPC source required')
                    assert.equal(npc.sceneId, f.state().world.map_id)
                    driver.move({ x: npc.posX, y: npc.posY, z: npc.posZ })
                    const items = data.itemDatas.map((item) => ({
                        item_type: data.itemBigType,
                        item_id: item.itemId,
                        item_count: item.count,
                    }))
                    const amounts = items.map((item) =>
                        item.item_type === 3
                            ? bagCount(item.item_id)
                            : (f.state().taskItems.find((entry) => entry.item_id === item.item_id)?.item_num ?? 0),
                    )
                    driver.call('TaskSubmitItem', { task_id: taskId, node_id: node.id, node_index: index, items })
                    for (const [position, item] of items.entries()) {
                        const value =
                            item.item_type === 3
                                ? bagCount(item.item_id)
                                : (f.state().taskItems.find((entry) => entry.item_id === item.item_id)?.item_num ?? 0)
                        assert.equal(value, amounts[position] - item.item_count)
                    }
                    events.push({ kind: 'submitted', node: node.id, items })
                },
                afterSourceAction(kind, data) {
                    assert.equal(kind, 'TaskCreatItemData')
                    assert.equal(data.bagType, 5)
                    assert(f.tables.find('task_item', data.itemId))
                    events.push({ kind: 'local-task-item-presentation', data })
                    return true
                },
                guidedCompletion(condition) {
                    const id = condition.__type_TaskConditionBaseData.__type_TaskCondGuidedAchievementsData.achievId
                    events.push({ kind: 'guided', id, before: guidedConditionValue(id, f.state()) })
                    if (id === 10041) buildHouse()
                    else if (id === 10047) {
                        const house = f
                            .state()
                            .home.builds.find((b) => f.tables.find('home_building', b.build_id)?.groupId === 2017)
                        const cap = f.tables.get('home_labor_capacity').find((c) => c.laborCapacityId === 1001)
                        const pet = f
                            .state()
                            .pets.find(
                                (p) =>
                                    !p.work_status &&
                                    p.labor_infos.some((l) => l.labor_id === cap.laborType && l.labor_grade > 0),
                            )
                        assert(pet)
                        const packets = driver.call('ChoseAutoWorkPet', {
                            build_guid: house.guid,
                            work_type: 1001,
                            pet_guid: pet.guid,
                        })
                        assert(wireComplete(packets, 68), 'Worker assignment must publish actual node68 progress')
                        assert.equal(f.state().pets.find((entry) => entry.guid === pet.guid).work_status, 5)
                        assert(
                            f
                                .state()
                                .player.group_mgrs.every((manager) =>
                                    manager.groups.every((group) =>
                                        group.heros.every((slot) => slot.pet_id !== pet.guid),
                                    ),
                                ),
                            'Worker must leave its formation',
                        )
                        events.push({ kind: 'stationed', pet: pet.guid, house: house.guid })
                    } else if (id === 10042) {
                        assert(guidedConditionValue(id, f.state()) >= 1)
                    } else if (id === 10048) {
                        const table = f.state().home.builds.find((b) => b.build_type === 6 && b.locate)
                        const bagFood = f
                            .state()
                            .player.sbag_infos.items.find(
                                (i) => i.itemnum > 0 && f.tables.find('common_item', i.itemid)?.type === 355,
                            )
                        assert(table)
                        const item =
                            f
                                .state()
                                .player.sbag_infos.items.find(
                                    (entry) =>
                                        entry.itemnum > 0 &&
                                        table.pet_canteen.foods.some(
                                            (food) => food.itemid === entry.itemid && food.itemnum > 0,
                                        ),
                                ) ?? bagFood
                        assert(item)
                        const countBefore = bagCount(item.itemid)
                        driver.call('AddPetFood', {
                            build_guid: table.guid,
                            operate_type: 1,
                            items: [{ itemid: item.itemid, itemnum: 1 }],
                        })
                        assert.equal(bagCount(item.itemid), countBefore - 1)
                    } else assert.fail('Unmodeled guidance ' + id)
                    assert(guidedConditionValue(id, f.state()) >= 1)
                },
            })
            try {
                assert.equal(before, 3156)
                while (f.state().tasks.some((t) => t.task_id === 106015)) {
                    assert(flow.visits.length < 40)
                    flow.step(106015)
                }
                const earned = f.state()
                assert.equal(earned.taskRecords.find((task) => task.task_id === 106015).count, 1)
                assert.equal(earned.taskItems.find((item) => item.item_id === 450125).item_num, 0)
                f.coldLogin()
                assert.equal(f.state().taskRecords.find((task) => task.task_id === 106015).count, 1)
                assert(!f.state().tasks.some((task) => task.task_id === 106015))
                assert.equal(f.state().taskItems.find((item) => item.item_id === 450125).item_num, 0)
                final = {
                    requests: f.requestCount(),
                    task: 106015,
                    record: f.state().taskRecords.find((task) => task.task_id === 106015),
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    nextMain: taskSnapshot(f.tables, f.state()).next_main_id,
                    world: f.state().world,
                    visits: flow.visits.map((row) => row.nodeId),
                }
                const result = afterChapter?.({ f, driver, observer, flow })
                assert(!result?.then, 'Chapter continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'chapter106015.json'),
                    JSON.stringify(
                        {
                            final,
                            before,
                            after: f.requestCount(),
                            visits: flow.visits,
                            events,
                            trace: observer.trace.slice(before),
                            state: f.state(),
                        },
                        null,
                        2,
                    ) + '\n',
                )
            }
        },
    })

    return { directory, final }
}
