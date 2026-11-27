import {
    fundCurrentCombatActors,
    qualifyCurrentCombatWorld,
    currentFixedGroup,
    currentCombatSeasonNow,
    qualifyCurrentEntrust,
} from './combat-normal-current-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
test('empty10737 is a read-only no-op; nonempty monster telemetry stays in memory and malformed batches roll back', () => {
    const store = new Store(':memory:', { flushIntervalMs: 60000 }),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'monster-scenes' })
        store.transact(session.id, 0, (s) => qualifyCurrentCombatWorld(tables, s))
        call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        const saved = () => store.db.prepare('select state,revision from players where account_id=?').get(session.id)
        const before = structuredClone(store.load(session.id).state),
            db = saved(),
            logs = store.db.prepare('select count(*) n from request_log').get().n
        assert.equal(protocol.encode(protocol.byName.get('CSProtoMonsterSceneChange').req, { infos: [] }).length, 0)
        assert.deepEqual(call('MonsterSceneChange', { infos: [] }), [])
        assert.deepEqual(call('MonsterSceneChange'), [])
        assert.deepEqual(store.load(session.id).state, before)
        assert.deepEqual(saved(), db)
        const id = currentFixedGroup(tables, store.load(session.id).state).ids[0]
        for (let i = 0; i < 20; i++)
            assert.deepEqual(call('MonsterSceneChange', { infos: [{ tar_id: id, scene: i % 4 }] }), [])
        assert.equal(store.load(session.id).state.combat.monsterScenes[id].scene, 3)
        assert.deepEqual(saved(), db)
        assert.equal(store.db.prepare('select count(*) n from request_log').get().n, logs)
        const state = structuredClone(store.load(session.id).state)
        assert.throws(() => {
            const e = protocol.byName.get('CSProtoMonsterSceneChange')
            return game.dispatch(session, {
                id: e.id,
                seq: seq++,
                payload: Buffer.from(
                    protocol
                        .type(e.req)
                        .encode({
                            infos: [
                                { tar_id: id, scene: 1 },
                                { tar_id: id, scene: 99 },
                            ],
                        })
                        .finish(),
                ),
            })
        }, /Invalid monster scene/)
        assert.deepEqual(store.load(session.id).state, state)
        assert.throws(
            () => call('MonsterSceneChange', { infos: [{ tar_id: state.player.heros_info.heros[0].guid, scene: 1 }] }),
            /Unknown scene monster/,
        )
        assert.throws(
            () => call('MonsterSceneChange', { infos: Array.from({ length: 257 }, () => ({ tar_id: id, scene: 1 })) }),
            /Invalid monster scene batch/,
        )
        assert.deepEqual(store.load(session.id).state, state)
        store.flushPending()
        assert.equal(JSON.parse(saved().state).combat.monsterScenes[id].scene, 3)
    } finally {
        store.close()
    }
})
