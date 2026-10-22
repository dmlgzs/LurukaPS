import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { worldDifficultyFixture } from './world-difficulty-fixture.js'
import { worldDifficultyCatalogue, selectedWorldDifficulty } from '../src/world-difficulty-catalogue.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { ErrorCode } from '../src/error-codes.js'

test('login initializes real per-map minima, preserving legacy choices and matching the native full sync shape', () => {
    const f = worldDifficultyFixture('difficulty-login')
    try {
        const packet = f.entryPackets.find((p) => p.id === 11400)
        const value = f.protocol.decode('SCWorldDifficultyInfoSync', packet.payload)
        assert.equal(value.send_type, 1) // Avoid the client type0 branch losing itemDic.
        assert.deepEqual(
            value.infos.map((v) => [v.map_id, v.difficulty]),
            [
                [100, 1],
                [101, 2],
            ],
        )
        assert.equal(worldDifficultyCatalogue(f.tables).rows.length, 7)
        const old = structuredClone(f.state())
        for (let i = 0; i < 100; i++) assert.equal(selectedWorldDifficulty(f.tables, f.state(), 101), 2)
        assert.deepEqual(f.state(), old)
    } finally {
        f.store.close()
    }
})

test('11401 validates actual task prerequisites, switches a remote map independently and sends state before ACK', () => {
    const f = worldDifficultyFixture('difficulty-switch')
    try {
        assert.throws(
            () => f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 }),
            (e) => e.code === ErrorCode.WorldDifficultyNotEnough,
        )
        f.unlock(101, 3)
        const world = structuredClone(f.state().world)
        const packets = f.call('WorldDifficultySwitch', { map_id: 101, difficulty: 3 })
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 101), 3)
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 100), 1)
        assert.deepEqual(f.state().world, world)
        const i = packets.findIndex((p) => p.id === 11400)
        assert(i >= 0 && i < packets.findIndex((p) => p.id === 11401))
        const sync = f.protocol.decode('SCWorldDifficultyInfoSync', packets[i].payload)
        assert.equal(sync.send_type, 1)
        assert.deepEqual(
            sync.infos.map((v) => [v.map_id, v.difficulty]),
            [[101, 3]],
        )
        assert(!packets.some((p) => p.id === 9115), 'legacy global-level protocol is not aliased')
    } finally {
        f.store.close()
    }
})

test('all seven current configured levels are selected only after their own table conditions', () => {
    const f = worldDifficultyFixture('difficulty-all-levels')
    try {
        for (const row of worldDifficultyCatalogue(f.tables).rows) {
            f.unlock(row.mapid, row.difficultLv)
            if (selectedWorldDifficulty(f.tables, f.state(), row.mapid) !== row.difficultLv)
                f.call('WorldDifficultySwitch', { map_id: row.mapid, difficulty: row.difficultLv })
            assert.equal(selectedWorldDifficulty(f.tables, f.state(), row.mapid), row.difficultLv)
        }
        assert.throws(
            () => f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 5 }),
            (e) => e.code === ErrorCode.WorldDifficultyLevelNotExist,
        )
    } finally {
        f.store.close()
    }
})

test('live enemies use the newly selected configured level and exact local HP ratio without teleport or hatred reset', () => {
    const f = worldDifficultyFixture('difficulty-live-enemy')
    try {
        const { uuid } = f.enemy(0.5)
        f.unlock(100, 3)
        const before = structuredClone(f.state()),
            old = before.combat.entities[uuid]
        const packets = f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 })
        const current = f.state().combat.entities[uuid],
            definition = enemyDefinition(f.tables, f.state(), uuid)
        assert.equal(current.level, definition.level)
        assert(current.level !== old.level)
        assert.equal(current.max_hp, definition.max_hp)
        assert.equal(
            current.hp,
            Number((BigInt(old.hp) * BigInt(definition.max_hp) + BigInt(old.max_hp) - 1n) / BigInt(old.max_hp)),
        )
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.state().combat.hatred, before.combat.hatred)
        const names = packets.map((p) => f.protocol.byId.get(p.id).name)
        assert(!names.includes('CSProtoWorldMapSync'))
        assert(!names.includes('CSProtoHatredResetSync'))
        assert(packets.some((p) => p.id === 10009))
    } finally {
        f.store.close()
    }
})

test('dead/captured history and metadata-only enemies never become living spawns after difficulty selection', () => {
    const f = worldDifficultyFixture('difficulty-dead')
    try {
        const { uuid } = f.enemy(0, true)
        f.unlock(100, 3)
        const before = structuredClone(f.state().combat.entities[uuid])
        f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 })
        assert.deepEqual(f.state().combat.entities[uuid], before)
        f.store.transact(f.session.id, 0, (s) => {
            const v = s.combat.entities[uuid]
            v.captured = true
        })
        f.unlock(100, 4)
        const captured = structuredClone(f.state().combat.entities[uuid])
        f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 4 })
        assert.deepEqual(f.state().combat.entities[uuid], captured)
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[uuid] = { uuid, level: before.level, updated_at: 1 }
        })
        f.unlock(100, 2)
        const packets = f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 2 })
        assert.equal(f.state().combat.entities[uuid].hp, undefined)
        assert(!packets.some((p) => p.id === 10009))
    } finally {
        f.store.close()
    }
})

test('same level, unknown maps/levels, injected redpoints and malformed saved difficulty fail atomically', () => {
    const f = worldDifficultyFixture('difficulty-invalid')
    try {
        for (const [r, code] of [
            [{ map_id: 100, difficulty: 1 }, ErrorCode.WorldDifficultyLevelSame],
            [{ map_id: 999999, difficulty: 3 }, ErrorCode.WorldDifficultyLevelNotExist],
            [
                { map_id: 100, difficulty: 3, redpoints_info: [{ difficulty: 3, redpoint: true }] },
                ErrorCode.InvalidArgument,
            ],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('WorldDifficultySwitch', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.worldDifficulties[100].difficulty = 999
        })
        assert.throws(
            () => f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('native sync, enemy HP sync and actual acknowledgement encoding failures preserve difficulty and battle state', () => {
    const f = worldDifficultyFixture('difficulty-codec'),
        encode = f.protocol.encode
    try {
        f.enemy(0.5)
        f.unlock(100, 3)
        for (const type of ['SCWorldDifficultyInfoSync', 'SCObjBattleInfoSync', 'ProtoNullRsp']) {
            const shared = f.state(),
                before = structuredClone(shared)
            let hit = false
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) {
                    hit = true
                    throw Error('difficulty encoding failed')
                }
                return encode.call(this, name, ...args)
            }
            assert.throws(
                () => f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 }),
                /difficulty encoding failed/,
            )
            assert(hit)
            assert.deepEqual(shared, before)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('WorldDifficultySwitch', { map_id: 100, difficulty: 3 })
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 100), 3)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('legacy active-map values and redpoint tuple migrate once, then selections survive real SQLite reopen and login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-world-difficulty-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = worldDifficultyFixture('difficulty-reopen', file)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.worldDifficulties
            delete s.worldDifficultyLegacyImported
            s.world.difficulty = 3
            s.flags.worldDifficultyRedPoints = [100, 3, 1]
        })
        f.store.close()
        f = worldDifficultyFixture('difficulty-reopen', file)
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 100), 3)
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [3])
        f.unlock(101, 3)
        f.call('WorldDifficultySwitch', { map_id: 101, difficulty: 3 })
        f.store.close()
        f = worldDifficultyFixture('difficulty-reopen', file)
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 100), 3)
        assert.equal(selectedWorldDifficulty(f.tables, f.state(), 101), 3)
        assert.deepEqual(f.state().worldDifficulties[100].redpoints, [3])
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-world-difficulty-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
