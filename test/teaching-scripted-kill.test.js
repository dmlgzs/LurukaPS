import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1,
        cast = 1800000000000
    const call = (n, r = {}) => {
        const e = protocol.byName.get('CSProto' + n)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'teaching-script-kill' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 40
        s.world.map_id = 100
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    call('TeachStart', { id: 308 })
    call('StartDungeonClientOk')
    call('TrialGroupChange', {
        open: true,
        force: true,
        trial_heros: [{ pos: 0, id: 1101010 }],
        trial_pets: [{ pos: 0, id: 0 }],
    })
    const id = state().trialGroup.heroes[0].guid
    const skill = (skill_id, index, stamp = String(++cast), actor = id) => {
        const request = { unit_id: actor, op_time: stamp, skill: { skill_id, index, begin_time: stamp } }
        call('SkillStart', request)
        return request
    }
    const element = (target = id, executor = id) =>
        call('BattleInfoReduce', {
            uint64_dic: [target, executor, '991234', '101010129'],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '1',
                        uniqueId: '3',
                        buff: { cfg_id: 4, executor_id: '2', creator_id: '2' },
                    },
                },
            ],
        })
    const proof = () => state().combat.teachingProof?.[1000010]?.step ?? 0
    const complete = () => {
        element()
        skill(10101005, 1)
        skill(10101005, 1)
        for (let i = 0; i < 3; i++) {
            skill(10101042, 0)
            skill(10101042, 1)
        }
    }
    const kills = () => ({
        guid: Object.values(state().combat.entities)
            .filter((e) => e.object_id === 1000010)
            .map((e) => e.uuid),
    })
    return { store, game, session, call, state, id, skill, element, proof, complete, kills }
}
test('Misha teaching requires its FSM triggers, accepts an early verified result, and waits for the configured cleanup before scene advance', () => {
    const f = fixture()
    try {
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
        assert.throws(() => f.call('StoryKill', f.kills()), /configured story kill/)
        f.skill(10101042, 1)
        assert.equal(f.proof(), 0)
        f.element()
        const first = f.skill(10101005, 1)
        f.call('SkillStart', first)
        assert.equal(f.proof(), 2, 'the identical cast is counted only once')
        f.skill(10101005, 0)
        assert.equal(f.proof(), 2)
        f.skill(10101005, 1)
        for (let i = 0; i < 3; i++) {
            f.skill(10101042, 0)
            f.skill(10101042, 1)
        }
        assert.equal(f.proof(), 9)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().storyCampaign.pending_end_scene, 6265)
        assert.deepEqual(f.state().storyCampaign.completed_scenes, [])
        assert.equal(f.state().teachingRecords, undefined)
        assert.throws(() => f.call('EnterDungeonScene', { scene_id: 6266 }), /not complete/)
        f.call('StoryKill', f.kills())
        assert.deepEqual(f.state().storyCampaign.completed_scenes, [6265])
        assert.equal(f.state().storyCampaign.pending_end_scene, undefined)
        assert.equal(f.state().storyCampaign.status, 2)
        assert.deepEqual(f.state().worldObjects['6265:1000010'].expand_data.battle_group.world_indexes, [])
        f.call('StoryKill', f.kills())
        f.call('EndDungeonScene', { result: 3 })
        f.call('EnterDungeonScene', { scene_id: 6266 })
        assert.equal(f.state().world.map_id, 6266)
        assert.equal(f.state().combat.teachingProof, undefined, 'proof cannot leak across teaching scenes')
    } finally {
        f.store.close()
    }
})
test('teaching proof is isolated on failed fast requests, rejects a different hero and defers per-cast SQL persistence', () => {
    const f = fixture()
    try {
        f.element()
        const revision = f.store.playerById.get(f.session.id).revision
        const owned = f.state().player.heros_info.heros.find((h) => h.guid !== f.id)
        f.skill(10101005, 1, '1800000000100', owned.guid)
        assert.equal(f.proof(), 1)
        const e = protocol.byName.get('CSProtoSkillStart'),
            original = f.game.handlers.get(e.id)
        f.game.handlers.set(e.id, (c, r) => {
            original(c, r)
            throw Error('injected after teaching observation')
        })
        assert.throws(() => f.skill(10101005, 1), /injected/)
        assert.equal(f.proof(), 1)
        f.game.handlers.set(e.id, original)
        f.skill(10101005, 1)
        assert.equal(f.proof(), 2)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
    } finally {
        f.store.close()
    }
})
test('already defeated ordinary teaching enemies accept the client cleanup without granting another kill or reward', () => {
    const f = fixture()
    try {
        const s = f.state(),
            enemies = Object.values(s.combat.entities),
            hero = f.id
        f.call('BattleInfoReduce', {
            uint64_dic: [hero, ...enemies.map((e) => e.uuid)],
            battle_info: enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
        })
        const before = f.state()
        f.call('StoryKill', f.kills())
        assert.deepEqual(f.state().storyCampaign.completed_scenes, before.storyCampaign.completed_scenes)
        assert.deepEqual(f.state().storyKillReceipts, before.storyKillReceipts)
        assert.deepEqual(f.state().player.basic_info, before.player.basic_info)
    } finally {
        f.store.close()
    }
})

test('Misha element condition follows its hero executor even when injected onto a training enemy', () => {
    const f = fixture()
    try {
        const enemy = f.kills().guid[0]
        f.element(enemy)
        assert.equal(f.proof(), 1, 'WaitElementAdd checks executor entity type, not the recipient')
        f.skill(10101005, 1)
        f.skill(10101005, 1)
        for (let i = 0; i < 3; i++) {
            f.skill(10101042, 0)
            f.skill(10101042, 1)
        }
        assert.equal(f.proof(), 9)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().storyCampaign.pending_end_scene, 6265)
        f.call('StoryKill', f.kills())
        assert.deepEqual(f.state().storyCampaign.completed_scenes, [6265])
        const before = f.state()
        f.call('StoryKill', f.kills())
        assert.deepEqual(f.state().storyKillReceipts, before.storyKillReceipts)
    } finally {
        f.store.close()
    }
})

test('an enemy applying the same element to the trial hero cannot forge the teaching proof', () => {
    const f = fixture()
    try {
        f.element(f.id, f.kills().guid[0])
        assert.equal(f.proof(), 0)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
        assert.throws(() => f.call('StoryKill', f.kills()), /configured story kill/)
    } finally {
        f.store.close()
    }
})
