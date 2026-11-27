import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentShadowApproach } from './next106015-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'
import { flight62035SourceProfile as source } from './flight62035-source-profile.js'

export async function runCurrentFlightMilestone({ outputDirectory, afterFlight } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-flight62035-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = {
        boundary: 'Genuine3073 prerequisite; current trigger/arrival/completion inputs, not Unity flight physics',
    }
    await runCurrentShadowApproach({
        outputDirectory: directory,
        afterApproach({ f, driver, observer }) {
            const before = f.requestCount(),
                local = [],
                requests = []
            const call = (name, value = {}) => {
                const packets = driver.call(name, value)
                requests.push({ name, value, ids: packets.map((packet) => packet.id) })
                return packets
            }
            const current = {
                ...driver,
                call,
                playStory(id) {
                    if (id !== source.intro.id) return driver.playStory(id)
                    assert.equal(f.tables.find('story', id).storyType, source.intro.type)
                    call('SetStoryId', {
                        story_id: id,
                        story_type: source.intro.type,
                        tag: source.intro.tag,
                        param: source.intro.clicks,
                        is_skip: false,
                    })
                },
            }
            const decodePlayable = (packets) => {
                const packet = packets.find((packet) => packet.id === 9400)
                assert(packet)
                return f.protocol.decode(f.protocol.byId.get(9400).rsp, packet.payload)
            }
            const flow = normalSuccessorFlow(f, current, {
                playableCompletion(data) {
                    assert.equal(data.playableId, source.playable)
                    const row = f.tables.find('playable', data.playableId)
                    assert.equal(row.type, 0)
                    assert.equal(row.stepMax, 3)
                    const point = String(row.position).split('|').map(Number)
                    const origin = {
                        x: Math.round(point[0] * 100),
                        y: Math.round(point[1] * 100),
                        z: Math.round(point[2] * 100),
                    }
                    assert.equal(f.state().world.map_id, data.playableData.sceneId)
                    const ownership = () => ({
                        pets: f.state().pets,
                        heroes: f.state().player.heros_info.heros,
                        groups: f.state().player.group_mgrs,
                        mount: f.state().world.mount,
                    })
                    const original = ownership()
                    assert.equal(original.mount, '0')
                    assert(
                        !original.pets.some((pet) => pet.config_id === source.localMount),
                        'Temporary mount must not be an owned grant',
                    )
                    driver.move(origin)
                    const start = () => {
                        const sync = decodePlayable(call('PlayableStart', { u32: data.playableId }))
                        assert.equal(sync.all_sync, false, 'Current OnRealStart callback must survive incremental sync')
                        assert.equal(sync.plays.find((play) => play.play_id === data.playableId).status, 1)
                        const beforeStatus = f.state()
                        const packets = call('WorldMapExtraStatus', { status: 5, arg: '0' })
                        assert.deepEqual(
                            packets.map((packet) => packet.id),
                            [9119],
                            'No full scene refresh for the local mount',
                        )
                        assert.deepEqual(f.state(), beforeStatus)
                        local.push({
                            kind: 'override-born-and-local-mount',
                            mount: source.localMount,
                            interaction: source.startInteraction,
                        })
                    }
                    start()
                    // A fresh client cannot reconstruct the zero-step local mount.
                    // The existing recovery must expose the same unfinished interaction.
                    f.coldLogin()
                    assert.equal(f.state().playableRuns?.[data.playableId], undefined)
                    assert.equal(f.state().playableFinishes?.[data.playableId], undefined)
                    assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id, 8)
                    assert.deepEqual(ownership(), original)
                    start()
                    current.playStory(source.intro.id)
                    local.push({ kind: 'intro-complete-and-auto-flight-start', story: source.intro.id })
                    assert.equal(source.waypoints.length, 9)
                    for (const waypoint of source.waypoints) {
                        // A bounded successful arrival schedule; these elapsed times
                        // are test inputs, not a recovered movement-speed formula.
                        f.advanceMs(2500)
                        const pos = {
                            x: Math.round(origin.x + waypoint.position.x * 100),
                            y: Math.round(origin.y + waypoint.position.y * 100),
                            z: Math.round(origin.z + waypoint.position.z * 100),
                        }
                        driver.move(pos)
                        local.push({
                            kind: 'waypoint-arrived',
                            index: waypoint.index,
                            blueprint: waypoint.blueprint,
                            pos,
                            localEffects: ['timeline', 'cast-slot1', 'object-complete'],
                        })
                        if (waypoint.blueprint === 300608) {
                            assert.equal(waypoint.intParam, 'StoryId#101124')
                            current.playStory(101124)
                        } else assert.equal(waypoint.blueprint, 300502)
                        assert.equal(f.state().playableRuns[data.playableId].finish_step, 0)
                        assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_values[0], 0)
                    }
                    local.push({ kind: 'native-move-done-and-playable-stop-success', suppliedMoveSuccess: true })
                    // PlayableStop(true) -> SetPlayableUnitFinish -> SetComplete uses
                    // the current stepMax once; circle completion is a local event.
                    const complete = decodePlayable(
                        call('PlayableStep', {
                            playId: data.playableId,
                            is_step: true,
                            finish_step: row.stepMax,
                            pos: origin,
                        }),
                    )
                    assert.equal(complete.all_sync, false)
                    assert.equal(complete.plays.find((play) => play.play_id === data.playableId).status, 2)
                    const finished = decodePlayable(
                        call('PlayableFinish', { playId: data.playableId, score: 0, pos: { x: 0, y: 0, z: 0 } }),
                    )
                    assert.equal(finished.all_sync, false)
                    assert.equal(f.state().playableFinishes[data.playableId].map_id, 100)
                    call('WorldMapExtraStatus', { status: 0, arg: '0' })
                    local.push({ kind: 'stop-event-restores-input-and-destroys-local-mount' })
                    assert.deepEqual(ownership(), original)
                },
            })
            try {
                assert.equal(before, 3073)
                flow.step(106015)
                assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id, 10)
                const finish = structuredClone(f.state().playableFinishes[62035])
                f.coldLogin()
                assert.deepEqual(f.state().playableFinishes[62035], finish)
                assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id, 10)
                assert.equal(
                    f.state().taskRecords.some((task) => task.task_id === 106015),
                    false,
                )
                proof.final = { requests: f.requestCount(), task: 106015, node: 10, finish, world: f.state().world }
                const result = afterFlight?.({ f, driver: current, observer, flow })
                assert(!result?.then, 'Flight continuation must run synchronously')
            } finally {
                Object.assign(proof, { before, after: f.requestCount(), local, requests, visits: flow.visits })
                fs.writeFileSync(
                    path.join(directory, 'flight62035.json'),
                    JSON.stringify({ ...proof, trace: observer.trace.slice(before) }, null, 2) + '\n',
                )
            }
        },
    })
    return proof
}
