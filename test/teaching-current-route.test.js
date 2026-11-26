import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { teachingConfig } from '../src/teaching.js'

function fixture(name, mutate) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    if (mutate) {
        const get = tables.get.bind(tables)
        tables.get = (name) => mutate(name, get(name))
    }
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1 }))
        s.player.basic_info.lv = 60
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
    })
    return {
        tables,
        protocol,
        store,
        game,
        call,
        edit,
        state,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
    }
}

test('all28 current non-duel teaching routes compile from current trial identities without old trailGroup', () => {
    const tables = new Tables(configuration().tables),
        rows = tables.get('train_task').filter((row) => [1, 2].includes(row.groupType))
    assert.equal(rows.length, 28)
    for (const row of rows) {
        const config = teachingConfig(tables, tables.find('dungeon', row.dungeonId))
        assert(config.scenes.length > 0)
        for (const entry of config.scenes) assert.equal(entry.trialGroupId, entry.scene.trialsId)
    }
    const lesson = teachingConfig(tables, tables.find('dungeon', 5000))
    assert.deepEqual(
        lesson.scenes.map((row) => row.scene.id),
        [601],
    )
    assert.equal(lesson.routeModel, 'current-identities-and-fsm-palette')
    const identityVariant = teachingConfig(tables, tables.find('dungeon', 5002))
    assert.deepEqual(
        identityVariant.scenes.map((row) => row.scene.id),
        [613],
    )
    const hero = teachingConfig(tables, tables.find('dungeon', 5004))
    assert.deepEqual(
        hero.scenes.map((row) => row.scene.id),
        [6251, 6252],
    )
})

test('actual TeachStart201 enters601, current5987 syncs its true trial group, rejects early victory and preserves assets across login/quit', () => {
    const f = fixture('teaching-current201')
    try {
        const before = f.state(),
            result = f.call('TeachStart', { id: 201 })
        let s = f.state()
        assert.equal(s.storyCampaign.teaching_id, 201)
        assert.equal(s.world.map_id, 601)
        assert(result.some((packet) => packet.id === 9103))
        const monsters = s.storyCampaign.scene_objects.flatMap((row) => row.expand_data?.battle_group?.monsters ?? [])
        assert.equal(
            monsters.length,
            1,
            'do not multiply the current scripted one-pack pool to match a UI preview count',
        )
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
        const packets = f.call('TrialGroupChange', { open: true, trial_id: 601 })
        assert.equal(f.state().trialGroup.current_group_id, 601)
        assert.equal(f.state().trialGroup.heroes.length, 2)
        const trial = f.protocol.byName.get('CSProtoTrialDatas')
        assert(
            packets.findIndex((packet) => packet.id === trial.id) < packets.findIndex((packet) => packet.id === 5987),
        )
        f.call('StartDungeonClientOk')
        f.reconnect()
        s = f.state()
        assert.equal(s.trialGroup.current_group_id, 601)
        assert.equal(s.storyCampaign.map_id, 601)
        assert.throws(() => f.call('TeachStart', { id: 201 }), /Another teaching/)
        f.call('CampaignQuit')
        s = f.state()
        assert(!s.storyCampaign)
        assert(!s.trialGroup)
        assert.deepEqual(s.player.heros_info.heros, before.player.heros_info.heros)
        assert.deepEqual(s.player.sbag_infos, before.player.sbag_infos)
        assert(!s.teachingRecords?.includes(201), 'entry or abort must not grant a teaching clear')
    } finally {
        f.store.close()
    }
})

test('actual hero TeachStart301 uses both current scene groups and restores its owned formation on abort', () => {
    const f = fixture('teaching-current301')
    try {
        const owned = f.state().player.group_mgrs[0].groups
        f.call('TeachStart', { id: 301 })
        const s = f.state()
        assert.deepEqual(s.storyCampaign.scenes, [6251, 6252])
        assert.equal(s.world.map_id, 6251)
        f.call('TrialGroupChange', { open: true, trial_id: 6251 })
        assert.equal(f.state().trialGroup.heroes.length, 1)
        assert.equal(f.state().trialGroup.heroes[0].conf_id, 107003)
        f.call('CampaignQuit')
        assert.deepEqual(f.state().player.group_mgrs[0].groups, owned)
        assert(!f.state().teachingRecords?.includes(301))
    } finally {
        f.store.close()
    }
})

test('selected current trial corruption is rejected atomically instead of falling back to a preview or an old roster', () => {
    const f = fixture('teaching-current-corrupt', (name, rows) =>
        name === 'heropet_interim_group'
            ? rows.map((row) => (row.id === 601 ? { ...row, hero_id: '1#1107001|2#99999999' } : row))
            : rows,
    )
    try {
        const before = f.state()
        assert.throws(() => f.call('TeachStart', { id: 201 }), /configuration is missing|unavailable/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('actual static hero301 clears both scenes, records and rewards once, and remains idempotent through repeat and login', () => {
    const f = fixture('teaching-current301-victory')
    let stamp = 1800000000000
    const killScene = () => {
        const source = f.state().trialGroup.heroes[0].guid
        const targets = f
            .state()
            .storyCampaign.scene_objects.filter((row) => row.active)
            .flatMap((row) => row.expand_data?.battle_group?.monsters ?? [])
        assert(targets.length > 0)
        for (const enemy of targets) {
            stamp += 100
            f.call('BattleInfoReduce', {
                base_time: String(stamp),
                uint64_dic: [source, enemy.uid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            })
            assert.equal(f.state().combat.entities[enemy.uid].hp, 0)
        }
        return [...new Set(targets.map((enemy) => enemy.obj_key.obj_id))]
    }
    try {
        const initialBag = structuredClone(f.state().player.sbag_infos)
        assert.equal(
            f.tables.get('train_task').find((row) => row.taskid === 301).passReward,
            '',
            'current301 has no configured item award; do not invent one',
        )
        f.call('TeachStart', { id: 301 })
        f.call('TrialGroupChange', { open: true, trial_id: 6251 })
        f.call('StartDungeonClientOk')
        killScene()
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().storyCampaign.status, 2, 'first scene is not the complete two-scene teaching task')
        assert(!f.state().teachingRecords?.includes(301))
        f.call('EnterDungeonScene', { scene_id: 6252, creator_id: f.state().player.basic_info.id })
        f.call('TrialGroupChange', { open: true, trial_id: 6252 })
        f.call('StartDungeonClientOk')
        killScene()
        f.call('EndDungeonScene', { result: 3 })
        let state = f.state()
        assert.equal(state.storyCampaign.status, 3)
        assert.equal(state.teachingRecords.filter((id) => id === 301).length, 1)
        assert.deepEqual(state.player.sbag_infos, initialBag)
        const earned = structuredClone(state.player)
        f.call('EndDungeonScene', { result: 3 })
        assert.deepEqual(f.state().player, earned)
        f.reconnect()
        assert.equal(f.state().teachingRecords.filter((id) => id === 301).length, 1)
        assert.deepEqual(f.state().player.sbag_infos, earned.sbag_infos)
        f.call('CampaignQuit')
        state = f.state()
        assert(!state.storyCampaign)
        assert(!state.trialGroup)
        assert.deepEqual(state.player.sbag_infos, earned.sbag_infos)
        const after = structuredClone(state.player)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        assert.deepEqual(f.state().player, after)
    } finally {
        f.store.close()
    }
})
