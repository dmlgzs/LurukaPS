import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { teachingConfig } from '../src/teaching.js'
import { teachingSceneVictory } from '../src/teaching-scene-victory.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function setup(filename = ':memory:', init = true) {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: p.id, seq: seq++, payload: protocol.encode(p.req, data) })
    }
    call('EnterGame', { open_id: 'teaching-entry-victory' })
    if (init)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 40
            s.world.map_id = 100
            s.tasks = []
            s.taskRecords = tables
                .get('task')
                .filter((t) => t.type === 1)
                .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
        })
    const state = () => store.load(session.id).state
    const defeatWave = () => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((e) => {
                const record = s.worldObjects[s.world.map_id + ':' + e.object_id]
                return (
                    e.hp > 0 &&
                    record?.active !== false &&
                    record?.expand_data?.battle_group?.world_indexes?.includes(e.slot)
                )
            })
        assert.ok(enemies.length)
        call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
            battle_info: enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
        })
    }
    return { store, call, state, session, defeatWave }
}
test('actual301 uses blueprint primary condition for6251 and6252, validates both waves and exits only after full route', () => {
    const f = setup()
    try {
        const route = teachingConfig(tables, tables.find('dungeon', 5004))
        assert.deepEqual(
            route.scenes.map((x) => x.scene.id),
            [6251, 6252],
        )
        assert.deepEqual(teachingSceneVictory(tables, route.scenes[1].scene), [2500, 99016, 0, 0, 2])
        const packets = f.call('TeachStart', { id: 301 })
        assert.ok(packets.some((p) => p.id === 11002))
        f.call('StartDungeonClientOk')
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
        f.defeatWave()
        f.call('EndDungeonScene', { result: 3 })
        f.call('EnterDungeonScene', { scene_id: 6252 })
        f.call('StartDungeonClientOk')
        f.defeatWave()
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
        f.defeatWave()
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().storyCampaign.status, 3)
        assert.ok(f.state().teachingRecords.includes(301))
        const before = f.state().player
        f.call('EndDungeonScene', { result: 3 })
        assert.deepEqual(f.state().player, before)
        f.call('CampaignQuit')
        assert.equal(f.state().storyCampaign, undefined)
        assert.equal(f.state().world.map_id, 100)
    } finally {
        f.store.close()
    }
})

function candidate(extra, rows) {
    const scenes = [...tables.get('dungeon_scene'), extra]
    return {
        dir: tables.dir,
        get: (name) => (name === 'dungeon_scene' ? scenes : name === 'worldmap_' + extra.id ? rows : tables.get(name)),
        find: (name, id) => (name === 'world_city' && id === extra.id ? { id, type: 2 } : tables.find(name, id)),
    }
}
test('valid unmatched candidate is excluded, ambiguity and damaged scene/enemy references remain strict errors', () => {
    const extra = {
            ...tables.find('dungeon_scene', 6252),
            id: 999981,
            trailGroup: '1107003#0|1101010#0',
            stringParam: '',
        },
        one = [{ id: 1, spawnerId: 99016, expandId: 22002 }]
    const valid = candidate(extra, one)
    assert.deepEqual(
        teachingConfig(valid, tables.find('dungeon', 5004)).scenes.map((x) => x.scene.id),
        [6251, 6252],
    )
    assert.throws(
        () => teachingConfig(candidate(extra, [{ ...one[0], expandId: 99999999 }]), tables.find('dungeon', 5004)),
        (e) => e.code === ErrorCode.NoEnemyConf,
    )
    assert.throws(
        () =>
            teachingConfig(
                candidate({ ...extra, victoryCondition: '2500#99016#0#0#0' }, one),
                tables.find('dungeon', 5004),
            ),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const duplicate = candidate(
        { ...extra, stringParam: tables.find('dungeon_scene', 6252).stringParam },
        tables.get('worldmap_6252'),
    )
    assert.throws(
        () => teachingConfig(duplicate, tables.find('dungeon', 5004)),
        (e) => e.code === ErrorCode.GameConfig && /ambiguous/.test(e.message),
    )
})

test('only the verified blueprint parameter may refine count, with matching condition identity and strict malformed rejection', () => {
    const scene = tables.find('dungeon_scene', 6252)
    for (const stringParam of [
        'finish_con_intlist#2500,99016,0,0,2|finish_con_intlist#2500,99016,0,0,2',
        'finish_con_intlist#2500,1,0,0,2',
        'finish_con_intlist#2500,99016,1,0,2',
        'finish_con_intlist#2500,99016,0,1,2',
        'finish_con_intlist#2500,99016,0,0,0',
        'finish_con_intlist#2500,99016,0,0,NaN',
    ])
        assert.throws(
            () => teachingSceneVictory(tables, { ...scene, stringParam }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    assert.deepEqual(teachingSceneVictory(tables, { ...scene, blueprintId: 0 }), [2500, 99016, 0, 0, 1])
})

test('11002 ACK encoding rolls back entry and SQLite reopen retains the complete selected route', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-teaching-route-')),
        filename = path.join(dir, 'state.sqlite')
    let f = setup(filename)
    try {
        const before = f.state(),
            old = protocol.encode,
            p = protocol.byId.get(11002)
        protocol.encode = function (name, data) {
            if (name === p.rsp) throw Error('teaching-entry-codec')
            return old.call(this, name, data)
        }
        try {
            assert.throws(() => f.call('TeachStart', { id: 301 }), /teaching-entry-codec/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
        f.call('TeachStart', { id: 301 })
        const instance = f.state().storyCampaign.instance_id
        f.store.close()
        f = setup(filename, false)
        assert.deepEqual(f.state().storyCampaign.scenes, [6251, 6252])
        assert.equal(f.state().storyCampaign.instance_id, instance)
        assert.equal(f.state().world.map_id, 6251)
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        assert(path.basename(dir).startsWith('luruka-teaching-route-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
