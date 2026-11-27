import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { ErrorCode } from '../src/error-codes.js'

const source = JSON.parse(fs.readFileSync(new URL('../configs/playable-enemies.json', import.meta.url)))
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const root = tables.get('worldmap_100').find((row) => row.expandId === 62043)
assert(root)

function fixture(name, store = new Store(':memory:')) {
    const session = {},
        game = new Game(protocol, store, tables)
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: name })
    // Explicit isolated map-entry fixture,not earned normal progression.
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 100
        state.world.pos = { x: 0, y: 0, z: 0 }
    })
    const query = () => {
        const entry = protocol.byName.get('CSProtoWorldObjEnemyInfo')
        const packets = call('WorldObjEnemyInfo', { play_id: 62043, obj_id: root.id })
        return protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
    }
    return { store, session, call, query, state: () => store.load(session.id).state }
}

test('runtime playable enemies bind current source version,tables and all current pack references', () => {
    assert.equal(source.version, '3217420')
    assert.equal(source.clientVersion, '1.0.0')
    assert.equal(source.playables.length, 596)
    for (const [name, key] of [
        ['playable', 'playableTableSha256'],
        ['world_enemy_group', 'enemyGroupTableSha256'],
        ['enemy_pack', 'enemyPackTableSha256'],
    ])
        assert.equal(source.provenance[key], sha(fs.readFileSync(path.join(config.tables, name + '.json'))))
    const ids = new Set()
    for (const entry of source.playables) {
        assert(tables.find('playable', entry.id) && !ids.has(entry.id))
        ids.add(entry.id)
        const { fingerprint, ...body } = entry
        assert.equal(fingerprint, sha(JSON.stringify(body)))
        for (const group of entry.groups) {
            assert.deepEqual(
                group.enemies,
                String(tables.find('world_enemy_group', group.enemy_group).enemyList)
                    .split('|')
                    .filter(Boolean)
                    .map(Number),
            )
            assert(group.enemies.every((id) => tables.find('enemy_pack', id)))
        }
    }
    assert.deepEqual(
        source.unavailable.map((row) => row.id),
        [20024, 20119, 62059, 62326],
    )
})

test('current62043 query returns stable account-owned identities for all configured groups', () => {
    const a = fixture('current-playable-source-a'),
        b = fixture('current-playable-source-b', a.store)
    try {
        const first = a.query(),
            second = b.query()
        assert.equal(first.monster_info.monsters.length, 17)
        assert.deepEqual([...new Set(first.monster_info.monsters.map((row) => row.index))], [0, 1, 2])
        assert.deepEqual(a.query(), first)
        assert(
            second.monster_info.monsters.every(
                (row) => !first.monster_info.monsters.some((other) => other.uuid === row.uuid),
            ),
        )
        for (const row of first.monster_info.monsters) assert(enemyDefinition(tables, a.state(), row.uuid)?.max_hp > 0)
    } finally {
        a.store.close()
    }
})

test('a stale configuration fingerprint renews current monster identities instead of retaining old actors', () => {
    const f = fixture('current-playable-source-rollover')
    try {
        const prior = f.query()
        f.store.transact(f.session.id, 0, (state) => {
            state.playableEnemies[`100:${root.id}:62043`].config_fingerprint = 'stale-prior-version'
        })
        const next = f.query()
        assert(
            next.monster_info.monsters.every(
                (row) => !prior.monster_info.monsters.some((old) => old.uuid === row.uuid),
            ),
        )
        for (const old of prior.monster_info.monsters) assert.equal(enemyDefinition(tables, f.state(), old.uuid), null)
        assert.deepEqual(f.query(), next)
    } finally {
        f.store.close()
    }
})

test('current enemy response encoding failure rolls back renewed identities and sequence allocation', () => {
    const f = fixture('current-playable-source-rollback'),
        encode = protocol.encode
    try {
        f.query()
        f.store.transact(f.session.id, 0, (state) => {
            state.playableEnemies[`100:${root.id}:62043`].config_fingerprint = 'stale-prior-version'
        })
        const before = f.state(),
            sequence = f.store.db
                .prepare('SELECT value FROM sequences WHERE name=?')
                .get('playable-monster-container').value
        protocol.encode = function (type, data) {
            if (type === protocol.byName.get('CSProtoWorldObjEnemyInfo').rsp) throw Error('current-playable-codec')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.query(), /current-playable-codec/)
        assert.deepEqual(f.state(), before)
        assert.equal(
            f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('playable-monster-container').value,
            sequence,
        )
        protocol.encode = encode
        assert.equal(f.query().monster_info.monsters.length, 17)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})

test('a table ID without an exact current asset is explicitly unavailable and does not return legacy monsters', () => {
    const f = fixture('current-playable-source-unavailable')
    try {
        const before = f.state()
        assert.throws(
            () => f.call('WorldObjEnemyInfo', { play_id: 62059 }),
            (error) => error.code === ErrorCode.PlayableNoConf,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
