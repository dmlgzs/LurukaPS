import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { acknowledgeAbyssSceneLoaded } from '../src/abyss-scene.js'
import { ErrorCode } from '../src/error-codes.js'

const battleImage = (state) => ({
    run: state.abyssRun,
    combat: state.combat,
    objects: state.worldObjects,
    abyss: state.abyss,
    world: state.world,
    player: state.player,
    pets: state.pets,
})

test('9509 accepts actual11451→9596 abyss graph readiness and duplicates without starting or resetting combat', () => {
    const f = abyssFixture('abyss-client-loaded')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('MultiCampaignPlayerLoaded')
        const ready = battleImage(f.state())
        assert.equal(ready.run.phase, 'ready')
        assert.equal(ready.run.real_start_time, undefined)
        for (let i = 0; i < 2; i++) {
            const packets = f.call('StartDungeonClientOk')
            assert(packets.some((packet) => packet.id === 9509))
            assert(!packets.some((packet) => [11460, 11461, 11464, 11468].includes(packet.id)))
            assert.deepEqual(battleImage(f.state()), ready)
        }
        f.call('AbyssChallengeRealStart')
        const running = battleImage(f.state())
        assert.equal(running.run.phase, 'running')
        assert.equal(running.run.real_start_time, f.time.now)
        for (let i = 0; i < 2; i++) {
            f.call('StartDungeonClientOk')
            assert.deepEqual(battleImage(f.state()), running)
        }
        // Controlled phase inputs test only the pure confirmation contract.
        // They are not claims that this test earned a win, loss or intro.
        for (const phase of ['intro', 'won', 'lost']) {
            const state = f.state()
            state.abyssRun.phase = phase
            const before = structuredClone(state)
            assert.deepEqual(acknowledgeAbyssSceneLoaded(f.tables, state), {})
            assert.deepEqual(state, before)
        }
        const highInstance = f.state()
        highInstance.abyssRun.instance_id = Number.MAX_SAFE_INTEGER
        const before = structuredClone(highInstance)
        assert.deepEqual(acknowledgeAbyssSceneLoaded(f.tables, highInstance), {})
        assert.deepEqual(highInstance, before, 'Internal instance IDs are not wire uint32 IDs')
    } finally {
        f.store.close()
    }
})

test('9509 rejects a foreign world and malformed or mismatched admitted abyss rooms without state changes', () => {
    const f = abyssFixture('abyss-client-loaded-invalid')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('MultiCampaignPlayerLoaded')
        const good = f.state()
        const cases = [
            [(state) => (state.world.map_id = 100), ErrorCode.NotInDungeonMap],
            [(state) => (state.abyssRun = null), ErrorCode.GameConfig],
            [(state) => (state.abyssRun.mode = '1'), ErrorCode.GameConfig],
            [(state) => (state.abyssRun.phase = 'unknown'), ErrorCode.GameConfig],
            [(state) => (state.abyssRun.part_index = -1), ErrorCode.GameConfig],
            [(state) => (state.abyssRun.rooms = {}), ErrorCode.GameConfig],
            [(state) => (state.abyssRun.level_id = 10002), ErrorCode.GameConfig],
            [(state) => state.abyssRun.rooms[0].dungeon_id++, ErrorCode.GameConfig],
            [(state) => state.abyssRun.rooms[0].point_id++, ErrorCode.GameConfig],
        ]
        for (const [mutate, code] of cases) {
            f.store.transact(f.session.id, 0, (state) => {
                for (const key of Object.keys(state)) delete state[key]
                Object.assign(state, structuredClone(good))
                mutate(state)
            })
            const before = f.state()
            assert.throws(
                () => f.call('StartDungeonClientOk'),
                (error) => error.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('9509 still rejects ordinary worlds and preserves the existing real story-dungeon loading branch', () => {
    const f = abyssFixture('abyss-client-loaded-story')
    try {
        const ordinary = f.state()
        assert.throws(
            () => f.call('StartDungeonClientOk'),
            (error) => error.code === ErrorCode.InvalidArgument && /No active dungeon/.test(error.message),
        )
        assert.deepEqual(f.state(), ordinary)
        // Existing chapter106014 test prerequisites; no completion is imported.
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 16
            state.world.map_id = 100
            state.tasks = [
                {
                    task_id: 106014,
                    nodes: [{ node_id: 11, node_values: [0], client_before: true }],
                    finish_nodes: [1, 3, 4, 21, 5, 8, 10, 12],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            state.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013, 996001].map((task_id) => ({
                task_id,
                count: 1,
                time: 1,
            }))
        })
        f.call('CampaignCreate', { group_id: 200, difficulty: 1 })
        const before = f.state()
        assert.equal(before.storyCampaign.dungeon_id, 10010)
        assert.equal(before.abyssRun, undefined)
        const packets = f.call('StartDungeonClientOk')
        assert(packets.some((packet) => packet.id === 9509))
        assert(packets.some((packet) => packet.id === f.p.byName.get('CSProtoCampaignInfoSync').id))
        assert.equal(f.state().storyCampaign.loading_complete_at, f.time.now)
        assert.deepEqual(f.state().combat.entities, before.combat.entities)
        assert.equal(f.state().storyCampaign.stage_index, before.storyCampaign.stage_index)
    } finally {
        f.store.close()
    }
})
