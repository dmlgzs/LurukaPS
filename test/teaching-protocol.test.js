import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { teachingConfig } from '../src/teaching.js'
import { registerTeaching } from '../src/handlers/teaching.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    t = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
for (const [taskId, scenes, trialId] of [
    [308, [6265, 6266], 1101010],
    [323, [6295, 6296], 1199008],
])
    test(`teaching ${taskId} enters its unique table roster, stages do not skip, trial party restores and clear is recorded`, () => {
        const s = new Store(':memory:'),
            g = new Game(p, s, t, { clock: () => 1800000000 }),
            session = {}
        let seq = 1
        const call = (name, r = {}) => {
            const e = p.byName.get('CSProto' + name)
            return g.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
        }
        const state = () => s.load(session.id).state
        try {
            call('EnterGame', { open_id: 'teaching-' + taskId })
            s.transact(session.id, 0, (x) => {
                x.world.map_id = 100
                x.player.basic_info.lv = 30
                x.taskRecords = t
                    .get('task')
                    .filter((r) => r.type === 1)
                    .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
                x.tasks = []
            })
            const formation = structuredClone(state().player.group_mgrs),
                world = structuredClone(state().world)
            const packets = call('TeachStart', { id: taskId, activity_id: 110001 })
            assert.ok(packets.some((x) => x.id === 11002))
            assert.deepEqual(state().storyCampaign.scenes, scenes)
            assert.equal(state().world.map_id, scenes[0])
            assert.ok(packets.some((x) => x.id === 9505))
            assert.throws(() => call('EndDungeonScene', { result: 3 }), /not defeated/)
            call('TrialGroupChange', {
                open: true,
                force: true,
                trial_heros: [{ pos: 0, id: trialId }],
                trial_pets: [{ pos: 0, id: 0 }],
            })
            assert.equal(state().trialGroup.heroes[0].hero_lv, 40)
            for (const scene of scenes) {
                if (scene !== scenes[0]) call('EnterDungeonScene', { scene_id: scene, creator_id: session.id })
                const snapshot = state(),
                    enemies = Object.values(snapshot.combat.entities).filter(
                        (e) => e.hp > 0 && snapshot.worldObjects[`${scene}:${e.object_id}`]?.active,
                    )
                assert.ok(enemies.length)
                const source = snapshot.trialGroup?.heroes[0]?.guid ?? snapshot.player.heros_info.heros[0].guid
                call('BattleInfoReduce', {
                    uint64_dic: [source, ...enemies.map((e) => e.uuid)],
                    battle_info: enemies.map((e, i) => ({
                        hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
                    })),
                })
                assert.ok(state().storyCampaign.completed_scenes.includes(scene))
                call('EndDungeonScene', { result: 3 })
                if (scene === scenes[0]) {
                    assert.equal(state().storyCampaign.status, 2)
                    assert.equal(state().teachingRecords, undefined)
                }
            }
            assert.equal(state().storyCampaign.status, 3)
            assert.ok(state().teachingRecords.includes(taskId))
            call('CampaignQuit')
            assert.equal(state().world.map_id, world.map_id)
            assert.deepEqual(
                state().player.group_mgrs.map((m) => ({ type: m.type, cur: m.cur_group, groups: m.groups })),
                formation.map((m) => ({ type: m.type, cur: m.cur_group, groups: m.groups })),
            )
            assert.equal(state().trialGroup, undefined)
            const login = p.byName.get('CSProtoEnterGame')
            const relog = g.dispatch(
                {},
                {
                    id: login.id,
                    seq: 1,
                    payload: p.encode(login.req, { open_id: 'teaching-' + taskId, reconnect: true }),
                },
            )
            assert.ok(p.decode('CSRepeatedUint32', relog.find((x) => x.id === 11001).payload).u32s.includes(taskId))
        } finally {
            s.close()
        }
    })
test('teaching resolver refuses a mismatched roster instead of guessing a scene', () => {
    const dungeon = structuredClone(t.find('dungeon', 5011))
    dungeon.id = 999999
    dungeon.enemy = '310001#100'
    const fake = Object.create(t)
    fake.get = (name) =>
        name === 'train_task' ? [{ ...t.get(name).find((x) => x.taskid === 308), dungeonId: dungeon.id }] : t.get(name)
    assert.throws(() => teachingConfig(fake, dungeon), /roster mapping/)
})

test('teaching request failures distinguish missing configuration, type, unlock, activity and active-run state', () => {
    const check = ({ code, train = {}, state = {}, activity, request = {} }) => {
        const tables = Object.create(t)
        tables.get = (name) =>
            name === 'train_task'
                ? t.get(name).map((row) => (row.taskid === 308 ? { ...row, ...train } : row))
                : t.get(name)
        const handlers = new Map()
        registerTeaching((name, handler) => handlers.set(name, handler), tables)
        const current = { player: { basic_info: { lv: 30 } }, world: { map_id: 100 }, ...state }
        const before = structuredClone(current)
        assert.throws(
            () =>
                handlers.get('TeachStart')(
                    { state: current, now: 1800000000, activityCatalog: activity },
                    { id: 308, ...request },
                ),
            (error) => error.code === code,
        )
        assert.deepEqual(current, before)
    }
    check({ request: { id: 0xffffffff }, code: ErrorCode.TrainTaskConfNone })
    check({ request: { id: 101 }, code: ErrorCode.TeachTypeNotExit })
    check({ state: { storyCampaign: { teaching_id: 308 } }, code: ErrorCode.IsTeaching })
    check({ state: { cultTrial: { map_id: 6550 } }, code: ErrorCode.InvalidLogic })
    check({ train: { unlockCondition: '2004#40' }, code: ErrorCode.TeachUnlock })
    check({ train: { unlockCondition: '2004#bad' }, code: ErrorCode.GameConfig })
    check({ train: { unlockCondition: '2007#106010' }, code: ErrorCode.InvalidLogic })
    check({ train: { dungeonId: 0xffffffff }, code: ErrorCode.DungeonConfNotExist })
    check({ request: { activity_id: 110001 }, activity: { rows: [] }, code: ErrorCode.NoActivityConf })
    check({
        request: { activity_id: 110001 },
        activity: { rows: [{ id: 110001, type: 1 }] },
        code: ErrorCode.ActivityTypeNotEqual,
    })
    check({
        request: { activity_id: 110001 },
        activity: { rows: [{ id: 110001, type: 110 }], window: () => ({ start_time: 1, end_time: 2 }) },
        code: ErrorCode.ActivityNotOpen,
    })
    check({
        request: { activity_id: 110001 },
        activity: {
            rows: [{ id: 110001, type: 110 }],
            window: () => ({ start_time: 1, end_time: 1800000001 }),
            unlocked: () => false,
        },
        code: ErrorCode.TeachUnlock,
    })
})

test('teaching resolver separates a missing scene from ambiguous or unsupported scene data', () => {
    assert.throws(
        () => teachingConfig(t, undefined),
        (error) => error.code === ErrorCode.DungeonConfNotExist,
    )
    assert.throws(
        () => teachingConfig(t, { ...t.find('dungeon', 5011), dungeonType: 400 }),
        (error) => error.code === ErrorCode.InstanceTypeError,
    )
    const fake = Object.create(t)
    fake.get = (name) => (name === 'dungeon_scene' ? [] : t.get(name))
    assert.throws(
        () => teachingConfig(fake, t.find('dungeon', 5011)),
        (error) => error.code === ErrorCode.InstanceSceneConfNotExist,
    )
    const duplicate = Object.create(t)
    duplicate.get = (name) => (name === 'dungeon_scene' ? [...t.get(name), t.find(name, 6265)] : t.get(name))
    assert.throws(
        () => teachingConfig(duplicate, t.find('dungeon', 5011)),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const unsupported = Object.create(t)
    unsupported.get = (name) =>
        name === 'dungeon_scene'
            ? t.get(name).map((row) => (row.id === 6265 ? { ...row, victoryCondition: '2007#99016#0#0#1' } : row))
            : t.get(name)
    assert.throws(
        () => teachingConfig(unsupported, t.find('dungeon', 5011)),
        (error) => error.code === ErrorCode.InvalidLogic,
    )
    assert.throws(
        () => teachingConfig(Object.create(t), { ...t.find('dungeon', 5011), enemy: 'bad#1' }),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const missingEnemies = Object.create(t)
    missingEnemies.find = (name, id) => (name === 'world_enemy_group' ? undefined : t.find(name, id))
    assert.throws(
        () => teachingConfig(missingEnemies, t.find('dungeon', 5011)),
        (error) => error.code === ErrorCode.NoEnemyConf,
    )
})
