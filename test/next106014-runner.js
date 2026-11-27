import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reachCurrent106014 } from './next106014-prerequisite.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'

// Recovered from3217420 exact program containers and current convenient rows.
// Full-play chooses the first offered option. This is a bounded local input
// model, not Unity rendering, movement physics, AI or damage calculation.
const profiles = new Map([
    [101090, [0, 0, 1]],
    [101091, [0, 0, 0]],
    [101092, [0, 0, 0]],
    [101093, [2, 0, 0]],
    [101096, [3, 0, 0]],
    [101097, [0, 0, 2]],
    [101099, [2, 0, 0]],
    [101100, [0, 0, 1]],
    [101104, [0, 0, 1]],
    [101105, [0, 0, 0]],
    [101106, [0, 0, 0]],
    [101107, [0, 0, 0]],
    [101108, [0, 0, 0]],
    [101109, [0, 0, 0]],
    [101110, [0, 0, 0]],
    [101111, [0, 0, 0]],
    [101112, [0, 0, 0]],
    [5101131, [2, 0, 0]],
    [5101132, [2, 0, 0]],
    [5101133, [1, 0, 0]],
    [1011001, [2, 0, 0]],
    [101101, [2, 0, 0]],
    [101102, [0, 0, 0]],
    [10110202, [3, 0, 0]],
    [101103, [2, 0, 0]],
])

export async function runCurrentWingsMilestone({ outputDirectory, afterChapter } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-wings106014-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = {
        boundary:
            'Genuine normal2890 prerequisite; current local story and HP inputs; no GM/save edits or Unity execution',
    }
    await reachCurrent106014({
        outputDirectory: directory,
        afterUnlock({ f, driver, observer }) {
            const before = f.requestCount(),
                calls = [],
                watches = [],
                waves = [],
                rejected = []
            const call = (name, value = {}) => {
                const packets = driver.call(name, value)
                calls.push({ name, value, ids: packets.map((packet) => packet.id) })
                return packets
            }
            const current = {
                ...driver,
                call,
                playStory(id, beforeWatch) {
                    const profile = profiles.get(id)
                    assert(profile, 'Current story profile required: ' + id)
                    const [type, tag, clicks] = profile
                    assert.equal(f.tables.find('story', id)?.storyType, type)
                    beforeWatch?.()
                    call('SetStoryId', { story_id: id, story_type: type, tag, param: clicks, is_skip: false })
                    watches.push({ id, type, tag, clicks })
                },
            }
            const snapshot = (packets) => {
                const packet = packets.filter((packet) => packet.id === 9505).at(-1)
                assert(packet)
                return f.protocol.decode(f.protocol.byId.get(9505).rsp, packet.payload)
            }
            const sceneIds = [6200, 6201]
            const reject = (name, value, message) => {
                const state = f.state()
                assert.throws(() => call(name, value), message)
                assert.deepEqual(f.state(), state)
                rejected.push({ name, value })
            }
            const defeat = (objectId) => {
                const map = f.state().world.map_id
                const group = f.state().worldObjects[map + ':' + objectId]
                assert.equal(group.active, true)
                const targets = group.expand_data.battle_group.monsters.map((row) => row.uid)
                assert(targets.length > 0)
                call('TryCreateWorldObj', { objs: targets })
                for (const target of targets) {
                    const definition = enemyDefinition(f.tables, f.state(), target)
                    const hp = f.state().combat.entities[target]?.hp ?? definition.max_hp
                    assert(hp > 1)
                    for (const delta of [-1, -(hp - 1)]) {
                        f.advanceMs(2)
                        call('BattleInfoReduce', {
                            base_time: String(f.nowMs()),
                            uint64_dic: [f.currentGroup().control, target],
                            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
                        })
                    }
                    assert.equal(f.state().combat.entities[target].hp, 0)
                }
                assert.equal(f.state().worldObjects[map + ':' + objectId].active, false)
                assert.deepEqual(
                    f.state().worldObjects[map + ':' + objectId].expand_data.battle_group.world_indexes,
                    [],
                )
                waves.push({ map, objectId, targets })
            }
            const enter = () => {
                const info = snapshot(call('CampaignCreate', { group_id: 200, difficulty: 1 }))
                assert.deepEqual(
                    info.scene_datas.map((row) => row.scene_id),
                    sceneIds,
                )
                assert.equal(info.cur_scene_id, 6200)
                assert.equal(info.status, 2)
                call('StartDungeonClientOk')
            }
            const flow = normalSuccessorFlow(f, current, {
                dungeonCompletion(data) {
                    assert.equal(data.dungeonId, 10010)
                    assert.equal(data.gotoDungeon, true)
                    const entry = current.graphs.get(106014).npcs.find((npc) => npc.createNpcId === 106014009)
                    assert.equal(entry.sceneId, 100)
                    assert.deepEqual(
                        entry.interactList.map((row) => row.argParam),
                        ['10010,task_interact_dungeon_14'],
                    )
                    current.move({ x: entry.posX, y: entry.posY, z: entry.posZ })
                    const entrance = f.state().world,
                        experience = f.state().player.basic_info.exp
                    enter()
                    reject('EnterDungeonScene', { scene_id: 6201 }, /Previous story dungeon scene is not complete/)
                    reject('EndDungeonScene', { result: 3 }, /enemies are not defeated/)
                    defeat(1500002)
                    defeat(1500004)
                    const intermediate = snapshot(call('EndDungeonScene', { result: 3 }))
                    assert.equal(intermediate.status, 2, 'first scene victory is not whole dungeon victory')
                    assert.deepEqual(
                        intermediate.scene_datas.map((row) => row.scene_status),
                        [1, 0],
                    )
                    assert.equal(f.state().storyCampaignClears?.[10010], undefined)
                    assert.equal(f.state().player.basic_info.exp, experience)
                    // A manual exit after the first scene must neither earn a clear
                    // nor carry dead groups into the next independent entry.
                    call('CampaignQuit')
                    assert.equal(f.state().storyCampaignClears?.[10010], undefined)
                    assert.equal(f.state().player.basic_info.exp, experience)
                    for (const key of ['map_id', 'point_id', 'area_id', 'pos', 'angle'])
                        assert.deepEqual(f.state().world[key], entrance[key])
                    f.coldLogin()
                    assert.equal(f.state().storyCampaignClears?.[10010], undefined)
                    enter()
                    defeat(1500002)
                    defeat(1500004)
                    call('EndDungeonScene', { result: 3 })
                    const next = snapshot(call('EnterDungeonScene', { scene_id: 6201 }))
                    assert.equal(next.cur_scene_id, 6201)
                    assert.equal(next.status, 2)
                    call('StartDungeonClientOk')
                    reject('EndDungeonScene', { result: 3 }, /enemies are not defeated/)
                    defeat(1500002)
                    const won = snapshot(call('EndDungeonScene', { result: 3 }))
                    assert.equal(won.status, 3)
                    assert.deepEqual(
                        won.scene_datas.map((row) => row.scene_status),
                        [1, 1],
                    )
                    const record = structuredClone(f.state().storyCampaignClears[10010])
                    const earnedExperience = f.state().player.basic_info.exp
                    assert.equal(record.count, 1)
                    call('EndDungeonScene', { result: 3 })
                    assert.deepEqual(f.state().storyCampaignClears[10010], record)
                    assert.equal(f.state().player.basic_info.exp, earnedExperience)
                    call('CampaignQuit')
                    for (const key of ['map_id', 'point_id', 'area_id', 'pos', 'angle'])
                        assert.deepEqual(f.state().world[key], entrance[key])
                    assert.equal(f.state().storyCampaign, undefined)
                },
            })
            try {
                assert.equal(before, 2890)
                const portal = new WorldObjectCatalog(f.tables).object(200, 200002)
                assert.equal(portal.row.interactOverrideParams, '10#10045')
                assert.equal(f.tables.find('world_borthpos', 10045).cityId, 100)
                current.move(portal.pos)
                call('EnterWorldMap', { map_id: 100, point_id: 10045, creator_id: f.state().player.basic_info.id })
                while (f.state().tasks.some((row) => row.task_id === 106014)) {
                    assert(flow.visits.length < 12)
                    flow.step(106014)
                }
                assert.deepEqual(
                    flow.visits.map((row) => row.nodeId),
                    [3, 4, 21, 5, 8, 10, 12, 11, 17, 19],
                )
                assert.equal(f.state().taskRecords.find((row) => row.task_id === 106014).count, 1)
                assert.equal(f.state().world.map_id, 100)
                assert.equal(f.state().world.point_id, 10083)
                const earned = f.state()
                f.coldLogin()
                assert.deepEqual(f.state().storyCampaignClears[10010], earned.storyCampaignClears[10010])
                assert.equal(f.state().taskRecords.find((row) => row.task_id === 106014).count, 1)
                proof.final = {
                    requests: f.requestCount(),
                    newRequests: f.requestCount() - before,
                    waves: waves.length,
                    visits: flow.visits.map((row) => row.nodeId),
                    world: f.state().world,
                    record: f.state().taskRecords.find((row) => row.task_id === 106014),
                }
                afterChapter?.({ f, driver: current, observer })
            } finally {
                Object.assign(proof, { before, after: f.requestCount(), visits: flow.visits, watches, waves, rejected })
                fs.writeFileSync(
                    path.join(directory, 'wings106014.json'),
                    JSON.stringify({ ...proof, calls, trace: observer.trace.slice(before) }, null, 2) + '\n',
                )
            }
        },
    })
    return proof
}
