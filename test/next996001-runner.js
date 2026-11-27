import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentPostMemoryMilestone } from './next106013-post-memory-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { EntrustCatalog } from '../src/entrust.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { preparedSystemAccess } from '../src/system-access.js'

export async function runCurrentCommissionMilestone({ outputDirectory, afterCommission } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-next996001-'))
    fs.mkdirSync(directory, { recursive: true })
    await runCurrentPostMemoryMilestone({
        outputDirectory: directory,
        afterChapter({ f, driver, observer }) {
            const before = f.requestCount(),
                calls = [],
                waves = []
            assert.equal(before, 740)
            const call = (name, value = {}) => {
                const packets = driver.call(name, value)
                calls.push({ name, value, packets: packets.map((packet) => packet.id) })
                return packets
            }
            const objects = new WorldObjectCatalog(f.tables)
            const completeEntrust = () => {
                assert.equal(f.state().entrust?.records?.[1]?.entrust_star ?? 0, 0)
                assert.equal(preparedSystemAccess(f.tables, f.state(), 173), true)
                call('EnterEntrust', { entrust_id: 1 })
                assert.equal(f.state().world.map_id, 647)
                call('MapLoadFinish')
                const catalog = new EntrustCatalog(f.tables),
                    stages = catalog.stages(1),
                    marker = stages[0].row,
                    { pos } = objects.object(647, marker.id)
                driver.move(pos)
                call('WorldObjInteract', {
                    objs: [{ obj: { obj_id: marker.id, complete: true, state_data: { step: 0 } }, interact_type: 0 }],
                })
                for (const stage of stages.filter((row) => row.type === 50)) {
                    assert.equal(f.state().entrust.run.stage_index, stage.index)
                    assert.equal(f.state().entrust?.records?.[1]?.entrust_star ?? 0, 0)
                    const record = f.state().worldObjects[`647:${stage.row.id}`].expand_data.battle_group
                    const targets = record.monsters.map((monster) => monster.uid)
                    assert(targets.length > 0)
                    call('TryCreateWorldObj', { objs: targets })
                    for (const target of targets) {
                        const definition = enemyDefinition(f.tables, f.state(), target)
                        const hp = f.state().combat.entities[target]?.hp ?? definition.max_hp
                        assert(hp > 1)
                        for (const damage of [-1, -(hp - 1)]) {
                            f.advanceMs(2)
                            call('BattleInfoReduce', {
                                base_time: String(f.nowMs()),
                                uint64_dic: [f.currentGroup().control, target],
                                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: damage } }],
                            })
                        }
                        assert.equal(f.state().combat.entities[target].hp, 0)
                    }
                    waves.push({ object: stage.row.id, targets })
                }
                assert.equal(f.state().entrust.run.battle_complete, true)
                assert(f.state().entrust.records[1].entrust_star >= 1)
                assert(
                    f.state().tasks.find((row) => row.task_id === 996001).nodes[0].node_values[0] >= 1,
                    'the real permanent star must satisfy80101 before paying for a chest',
                )
                const stamina = f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3)
                const beforeStamina = BigInt(stamina?.attr_val ?? '0')
                const paid = call('StaminaBoxGet', { box_id: 1010101, times: 1 })
                const claim = paid.find((packet) => packet.id === 9974)
                assert(claim)
                assert(f.protocol.decode(f.protocol.byId.get(9974).rsp, claim.payload).reward.rewards.length > 0)
                assert.equal(
                    BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3)?.attr_val ?? '0'),
                    beforeStamina - 30n,
                )
                call('CampaignQuit')
                assert.equal(f.state().world.map_id, 200)
                assert.equal(f.state().entrust.run, undefined)
            }
            const current = {
                ...driver,
                call,
                playStory(id) {
                    assert.equal(id, 805682)
                    assert.equal(f.tables.find('story', id).storyType, 1)
                    call('SetStoryId', { story_id: id, story_type: 1, tag: 0, param: 0, is_skip: false })
                },
            }
            const flow = normalSuccessorFlow(f, current, {
                npcStoryCompletion(data) {
                    assert.equal(data.storyId, 805682)
                    current.playStory(data.storyId)
                },
                guidedCompletion(condition) {
                    assert.equal(
                        condition.__type_TaskConditionBaseData.__type_TaskCondGuidedAchievementsData.achievId,
                        80101,
                    )
                    completeEntrust()
                },
            })
            try {
                assert.equal(preparedSystemAccess(f.tables, f.state(), 173), false)
                const portal = objects.object(100, 200010)
                driver.move(portal.pos)
                call('EnterWorldMap', { map_id: 200, point_id: 20001, creator_id: f.state().player.basic_info.id })
                while (f.state().tasks.some((row) => row.task_id === 996001)) {
                    assert(flow.visits.length < 6)
                    flow.step(996001)
                }
                assert.equal(f.state().taskRecords.find((row) => row.task_id === 996001).count, 1)
                assert.equal(waves.length, 2)
                const earned = structuredClone(f.state().entrust.records[1]),
                    paidStamina = f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val
                f.coldLogin()
                assert.equal(f.state().taskRecords.find((row) => row.task_id === 996001).count, 1)
                assert.deepEqual(f.state().entrust.records[1], earned)
                assert.equal(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val, paidStamina)
                call('EnterEntrust', { entrust_id: 1 })
                assert.equal(f.state().entrust.run.battle_complete ?? false, false)
                assert.equal(f.state().entrust.run.star, 0)
                assert.equal(f.state().entrust.records[1].entrust_star, earned.entrust_star)
                call('CampaignQuit')
                assert.equal(f.state().world.map_id, 200)
                assert.equal(f.state().entrust.run, undefined)
                assert.deepEqual(
                    flow.visits.map((visit) => visit.nodeId),
                    [6, 3, 4, 5],
                )
                assert.equal(
                    waves.reduce((count, wave) => count + wave.targets.length, 0),
                    12,
                )
                assert.equal(
                    f.requestCount(),
                    791,
                    'genuine740 prefix plus current quest, victory, chest, cold and replay entry',
                )
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'next996001.json'),
                    JSON.stringify(
                        {
                            before,
                            requests: f.requestCount(),
                            calls,
                            waves,
                            visits: flow.visits,
                            summary: f.summary(),
                            trace: observer.trace.slice(before),
                        },
                        null,
                        2,
                    ) + '\n',
                )
            }
            const result = afterCommission?.({ f, driver, observer })
            assert(!result?.then, 'Commission continuation must run synchronously')
        },
    })
}
