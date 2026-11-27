import {
    fundCurrentCombatActors,
    qualifyCurrentCombatWorld,
    currentFixedGroup,
    currentCombatSeasonNow,
    qualifyCurrentEntrust,
} from './combat-normal-current-fixture.js'
import { populateParty } from './party-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)

test('high-frequency combat reports stay in memory until a critical request or shutdown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-combat-memory-')),
        file = path.join(dir, 'state.sqlite')
    let store = new Store(file, { flushIntervalMs: 60000 })
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, value) })
    }
    const database = () => store.db.prepare('select state,revision from players where account_id=?').get(session.id)
    try {
        call('EnterGame', { open_id: 'combat-memory' })
        store.transact(session.id, 0, (s) => {
            qualifyCurrentCombatWorld(tables, s)
            fundCurrentCombatActors(tables, s)
            populateParty(s)
        })
        call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        const id = currentFixedGroup(tables, store.load(session.id).state, { minHp: 100 }).ids[0],
            hero = store.load(session.id).state.player.heros_info.heros[0].guid
        const before = database(),
            count = store.db.prepare('select count(*) n from request_log').get().n
        for (let i = 0; i < 40; i++)
            call('BattleInfoReduce', {
                base_time: String(1800000000000 + seq),
                uint64_dic: [hero, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
            })
        call('SkillStart', { unit_id: hero, skill: { skill_id: 20011 } })
        call('SkillStop', { unit_id: hero, skill_id: '20011' })
        call('StateUpdate', {
            move_msg: {
                map_id: 100,
                move: [{ uuid: hero, info: { pos: { x: 12345, y: 6789, z: 22222 }, angle: 90 } }],
            },
        })
        assert.equal(database().revision, before.revision)
        assert.equal(database().state, before.state)
        assert.equal(store.db.prepare('select count(*) n from request_log').get().n, count)
        assert(store.load(session.id).state.combat.entities[id].hp > 0)
        assert.deepEqual(store.load(session.id).state.world.pos, { x: 12345, y: 6789, z: 22222 })
        call('WorldMapPlayerMountStatus', { u32: 0 })
        assert.equal(database().revision, before.revision + 1)
        assert.equal(
            JSON.parse(database().state).combat.entities[id].hp,
            store.load(session.id).state.combat.entities[id].hp,
        )
        assert.deepEqual(JSON.parse(database().state).world.pos, { x: 12345, y: 6789, z: 22222 })
        call('BattleInfoReduce', {
            base_time: String(1800000000000 + seq),
            uint64_dic: [hero, id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
        })
        const saved = store.load(session.id).state.combat.entities[id].hp
        store.close()
        store = null
        const reopened = new Store(file)
        try {
            assert.equal(reopened.load(session.id).state.combat.entities[id].hp, saved)
        } finally {
            reopened.close()
        }
    } finally {
        if (store) store.close()
        fs.rmSync(dir, { recursive: true })
    }
})
