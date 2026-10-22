import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rescueFixture } from './actor-rescue-fixture.js'
import { heroBattleLimits, heroModules } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'

test('10738 accumulates native self-rescue deltas and notifies map peers without RPC ACK or immediate SQL', () => {
    const f = rescueFixture('rescue-self')
    try {
        const id = f.heroes[0]
        f.overHurt(id)
        const before = structuredClone(f.state()),
            writes = f.sql()
        const first = f.rescue(id, id, 255)
        assert.deepEqual(f.notifications(first), [{ from_uuid: id, tar_uuid: id, final_val: 255 }])
        assert.equal(first.length, 4)
        assert(
            first.filter((p) => p.audience).every((p) => p.audience.map === 100 && p.audience.sender === f.session.id),
        )
        for (let n = 0; n < 9; n++) f.rescue(id, id, 255)
        assert.equal(f.saved(id).rescue_val, 2550)
        assert.equal(f.saved(id).alive_state, 2)
        assert.equal(f.saved(id).hp, 0)
        assert.equal(f.saved(id).sp, 7)
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.state().pets, before.pets)
        assert.equal(f.sql(), writes)
    } finally {
        f.store.close()
    }
})

test('completion saturates at 10000, applies explicit table-based local HP policy, and never reheals late reports', () => {
    const f = rescueFixture('rescue-completion')
    try {
        const id = f.heroes[0]
        f.overHurt(id, 9900)
        const hero = f.state().player.heros_info.heros.find((h) => h.guid === id)
        const max = heroBattleLimits(heroModules(f.tables, f.state(), hero)).hp
        const rate = Number(f.tables.get('game').find((r) => r.title === 'WORLD_HERO_REBORN_HP').value)
        const packets = f.rescue(id, id, 600)
        assert.equal(f.notifications(packets)[0].final_val, 10000)
        assert.equal(f.saved(id).hp, Math.max(1, Math.floor((max * rate) / 10000)))
        assert.equal(f.saved(id).alive_state, 0)
        assert.equal(f.saved(id).rescue_val, 0)
        const hp = f.saved(id).hp
        assert.equal(f.notifications(f.rescue(id, id, 10000))[0].final_val, 0)
        assert.equal(f.saved(id).hp, hp)
        assert.equal(f.saved(id).sp, 7)
    } finally {
        f.store.close()
    }
})

test('controlled friendly rescue checks distance and source health, preserving accumulated target progress', () => {
    const f = rescueFixture('rescue-other')
    try {
        const [from, to] = f.heroes
        f.overHurt(to)
        f.rescue(from, to, 250)
        assert.equal(f.state().combat.rescueSources[from], to)
        assert.equal(f.saved(to).rescue_val, 250)
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[to] = { uuid: to, pos: { x: 10000, y: 100, z: 100 } }
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.rescue(from, to, 1),
            (e) => e.code === ErrorCode.InteractDistanceTooFar,
        )
        assert.deepEqual(f.state(), before)
        f.overHurt(from)
        assert.throws(
            () => f.rescue(from, to, 1),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
    } finally {
        f.store.close()
    }
})

test('dead is not over-hurt; missing, undeployed, malformed and multi-row invalid actors roll back', () => {
    const f = rescueFixture('rescue-invalid')
    try {
        const [from, to] = f.heroes
        f.overHurt(from)
        f.overHurt(to)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.battle_infos.find((h) => h.hero_id === to).alive_state = 1
        })
        for (const rows of [
            [],
            [{ from_uuid: from, tar_uuid: to, val: 100 }],
            [{ from_uuid: from, tar_uuid: '5', val: 100 }],
            [{ from_uuid: from, tar_uuid: from, val: 0 }],
            [
                { from_uuid: from, tar_uuid: from, val: 100 },
                { from_uuid: from, tar_uuid: '5', val: 100 },
            ],
        ]) {
            const shared = f.state(),
                before = structuredClone(shared),
                writes = f.sql()
            assert.throws(() => f.call('RescueObj', { rescue_infos: rows }))
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
            assert.equal(f.sql(), writes)
        }
    } finally {
        f.store.close()
    }
})

test('notification and alive-state codec failures cannot leak progress or completed HP through a fast draft', () => {
    const f = rescueFixture('rescue-codec'),
        encode = f.protocol.encode
    try {
        const id = f.heroes[0]
        for (const type of ['SCRescueObjNtf', 'SCObjBattleInfoSync']) {
            f.overHurt(id, 9999)
            const shared = f.state(),
                before = structuredClone(shared),
                writes = f.sql()
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('rescue codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.rescue(id, id, 10), /rescue codec failed/)
            assert.deepEqual(shared, before)
            assert.deepEqual(f.state(), before)
            assert.equal(f.sql(), writes)
            f.protocol.encode = encode
        }
        f.rescue(id, id, 10)
        assert.equal(f.saved(id).alive_state, 0)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('real SQLite reopen and login retain partial rescue progress and completed HP', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-rescue-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = rescueFixture('rescue-reopen', file)
        const id = f.heroes[0]
        f.overHurt(id)
        f.rescue(id, id, 400)
        f.store.close()
        f = rescueFixture('rescue-reopen', file)
        assert.equal(f.saved(id).rescue_val, 400)
        assert.equal(f.saved(id).alive_state, 2)
        const restored = f.entryPackets
            .filter((p) => p.id === 10009)
            .flatMap((p) => f.protocol.decode('SCObjBattleInfoSync', p.payload).infos)
            .find((h) => h.uuid === id)
        assert.equal(restored.rescue_val, 400)
        assert.equal(restored.alive_state, 2)
        f.rescue(id, id, 9600)
        f.store.close()
        f = rescueFixture('rescue-reopen', file)
        assert.equal(f.saved(id).alive_state, 0)
        assert(f.saved(id).hp > 0)
        assert.equal(f.saved(id).rescue_val, 0)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-rescue-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('active trial heroes use their own rescue record and undeployed owned heroes are rejected', () => {
    const f = rescueFixture('rescue-trial')
    try {
        const id = ((5n << 56n) | 987n).toString(),
            oldId = f.heroes[0]
        f.store.transact(f.session.id, 0, (s) => {
            s.trialGroup = { heroes: [{ ...s.player.heros_info.heros[0], guid: id, trail: true }], pets: [] }
            const group = s.player.group_mgrs[0].groups.find((g) => g.id === 1)
            group.heros[0] = { hero_id: id, pet_id: '0' }
            group.control = id
            s.player.heros_info.battle_infos.push({ hero_id: id, hp: 0, sp: 3, alive_state: 2 })
        })
        f.rescue(id, id, 100)
        assert.equal(f.saved(id).rescue_val, 100)
        assert.equal(f.saved(id).sp, 3)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.rescue(oldId, oldId, 100),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('invalid configured completion HP cannot consume an already earned partial rescue', () => {
    const f = rescueFixture('rescue-bad-config')
    try {
        const id = f.heroes[0],
            row = f.tables.get('game').find((r) => r.title === 'WORLD_HERO_REBORN_HP')
        f.overHurt(id, 9900)
        const before = structuredClone(f.state())
        row.value = 'broken'
        assert.throws(
            () => f.rescue(id, id, 100),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        row.value = '1000'
        f.rescue(id, id, 100)
        assert.equal(f.saved(id).alive_state, 0)
    } finally {
        f.store.close()
    }
})
