import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mountLifecycleFixture } from './mount-lifecycle-fixture.js'
import { group } from '../src/handlers/common.js'
import { checkWorldEventConditions } from '../src/world-event-runtime.js'
import { ErrorCode } from '../src/error-codes.js'
import runtimeConfig from '../configs/world-event-runtime.json' with { type: 'json' }

function fixture(name = 'event-condition', file = ':memory:', resume = false) {
    const f = mountLifecycleFixture(name, file, resume)
    const decoded = (name, data = {}) =>
        f
            .call(name, data)
            .map((p) => ({ id: p.id, data: f.game.protocol.decode(f.game.protocol.byId.get(p.id).rsp, p.payload) }))
    const center = (id) => runtimeConfig.events.find((r) => r.id === id).checks[0].center
    const setPosition = (id, delta = 0) =>
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
            const p = center(id)
            s.world.pos = { x: Math.round((p.x + delta) * 100), y: Math.round(p.y * 100), z: Math.round(p.z * 100) }
        })
    const move = (id, delta = 0) => {
        const p = center(id)
        return decoded('StateUpdate', {
            move_msg: {
                map_id: 100,
                move: [
                    {
                        uuid: f.store.read(f.session.id, (s) => group(s).control),
                        info: {
                            pos: {
                                x: Math.round((p.x + delta) * 100),
                                y: Math.round(p.y * 100),
                                z: Math.round(p.z * 100),
                            },
                        },
                    },
                ],
            },
        })
    }
    if (!resume) setPosition(101)
    return {
        ...f,
        decoded,
        center,
        setPosition,
        move,
        trigger: (id) => decoded('WorldEventTrigger', { cfg_id: id }).filter((p) => p.id === 10717),
        step: (id, step) => decoded('WorldEventStep', { cfg_id: id, step }),
    }
}
const code = (expected) => (error) => error.code === expected

test('all37 actual event asset references retain provenance and missing121 without changing unconditional admission', () => {
    const f = fixture()
    try {
        assert.deepEqual(runtimeConfig.coverage, {
            events: 37,
            nonemptyAssets: 32,
            extractedAssets: 31,
            directBlueprintIds: 26,
            directBlueprintGraphs: 14,
            missingAssets: [121],
            missingBlueprints: [121],
        })
        assert.equal(runtimeConfig.events.length, 37)
        assert(runtimeConfig.source.every((r) => /^[a-f0-9]{64}$/.test(r.sha256)))
        assert.equal(f.game.tables.find('world_event', 104).conditionID, '40001#1#2')
        assert.equal(f.game.tables.find('world_event', 111).conditionID, '40003#100#100240224#1')
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 996
        })
        assert.equal(f.trigger(121)[0].data.infos[0].step, 1)
    } finally {
        f.store.close()
    }
})

test('real101 response then real10716 step2 authorizes104; historical record alone does not', () => {
    const f = fixture()
    try {
        const before = f.state()
        assert.throws(() => f.trigger(104), code(ErrorCode.WorldEvCondition))
        assert.deepEqual(f.state(), before)
        assert.equal(f.trigger(101)[0].data.infos[0].step, 1)
        f.step(101, 2)
        assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
        assert.equal(f.state().worldEventAdmissions['100:104'].generation, 1)
        f.step(101, 3)
        // Existing admission may be re-synchronized after its entry predicate changes.
        assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
        assert.deepEqual(f.step(104, 2).find((p) => p.id === 10716).data.rewards, [])
        assert.equal(f.state().worldEvents['100:104'].completed, true)
    } finally {
        f.store.close()
    }
    const history = fixture('event-history')
    try {
        history.trigger(101)
        history.step(101, 2)
        history.store.transact(history.session.id, 0, (s) => {
            delete s.world.eventRuntime
            delete s.worldEventAdmissions
        })
        assert.throws(() => history.trigger(104), code(ErrorCode.WorldEvCondition))
    } finally {
        history.store.close()
    }
})

test('differing simultaneous group steps are explicitly unsupported, never highest or JSON order', () => {
    const f = fixture('event-ambiguous')
    try {
        f.trigger(101)
        f.step(101, 2)
        f.move(102)
        f.trigger(102)
        f.step(102, 2)
        f.step(102, 3)
        assert.equal(f.state().world.eventRuntime.entries.length, 2)
        const before = f.state()
        assert.throws(() => f.trigger(104), code(ErrorCode.FunctionClosed))
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('real111 absent target stays false; current object optional false differs from missing and corrupt', () => {
    const f = fixture('event-object')
    try {
        f.setPosition(111)
        assert.equal(
            f.game.tables.get('worldmap_100').some((r) => r.id === 100240224),
            false,
        )
        assert.throws(() => f.trigger(111), code(ErrorCode.WorldEvCondition))
        const id = f.game.tables.get('worldmap_100')[0].id,
            state = f.state()
        const context = { state, tables: f.game.tables, connectionKey: f.session.token }
        const condition = (conditionID) => ({ id: 111, worldMapID: 100, conditionID })
        assert.throws(
            () => checkWorldEventConditions(context, condition(`40003#100#${id}#0`)),
            code(ErrorCode.WorldEvCondition),
        )
        state.worldObjects = { [`100:${id}`]: { obj_id: id } }
        checkWorldEventConditions(context, condition(`40003#100#${id}#0`))
        state.worldObjects[`100:${id}`].complete = true
        checkWorldEventConditions(context, condition(`40003#100#${id}#1`))
        assert.throws(
            () => checkWorldEventConditions(context, condition(`40003#101#${id}#1`)),
            code(ErrorCode.WorldEvCondition),
        )
        state.worldObjects[`100:${id}`].complete = 'true'
        assert.throws(
            () => checkWorldEventConditions(context, condition(`40003#100#${id}#1`)),
            code(ErrorCode.GameConfig),
        )
    } finally {
        f.store.close()
    }
})

test('accepted movement closes admitted instance on real range+100 exit without rewriting unrelated state or SQL', () => {
    const f = fixture('event-movement')
    try {
        f.trigger(101)
        f.step(101, 2)
        f.store.flushPending()
        f.move(101)
        const old = f.store.pending.get(f.session.id).state,
            oldRuntime = old.world.eventRuntime,
            oldRuntimeText = JSON.stringify(oldRuntime)
        const before = f.store.db.prepare('select state, revision from players where account_id=?').get(f.session.id)
        const changes = f.store.db.prepare('select total_changes() as n').get().n
        for (let i = 0; i < 300; i++) f.move(101, i % 2)
        const current = f.store.pending.get(f.session.id).state
        assert.equal(current.player, old.player)
        assert.equal(current.pets, old.pets)
        assert.equal(current.world.eventRuntime, oldRuntime)
        assert.deepEqual(
            f.store.db.prepare('select state, revision from players where account_id=?').get(f.session.id),
            before,
        )
        assert.equal(f.store.db.prepare('select total_changes() as n').get().n, changes)
        f.move(101, 200)
        assert.equal(f.state().world.eventRuntime.entries.length, 0)
        assert.equal(JSON.stringify(oldRuntime), oldRuntimeText)
        f.move(101)
        assert.throws(() => f.trigger(104), code(ErrorCode.WorldEvCondition))
        f.trigger(101)
        assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
    } finally {
        f.store.close()
    }
})

test('reply encoding failure rolls back the trigger, admission ordinal and runtime', () => {
    const f = fixture('event-codec')
    try {
        const before = f.state(),
            encode = f.game.protocol.encode,
            type = f.game.protocol.byId.get(10717).rsp
        f.game.protocol.encode = function (t, value) {
            if (t === type) throw Error('event codec failure')
            return encode.call(this, t, value)
        }
        try {
            assert.throws(() => f.trigger(101), /event codec failure/)
        } finally {
            f.game.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.trigger(101)[0].data.infos[0].step, 1)
    } finally {
        f.store.close()
    }
})

test('movement encoding failure restores small runtime reference and position', () => {
    const f = fixture('event-move-codec')
    try {
        f.trigger(101)
        f.step(101, 2)
        const before = f.state(),
            encoded = JSON.stringify(before.world.eventRuntime),
            encode = f.game.protocol.encode
        const type = f.game.protocol.byName.get('CSProtoStateUpdateBC').rsp
        f.game.protocol.encode = function (t, value) {
            if (t === type) throw Error('movement codec failure')
            return encode.call(this, t, value)
        }
        try {
            assert.throws(() => f.move(101, 200), /movement codec failure/)
        } finally {
            f.game.protocol.encode = encode
        }
        assert.equal(JSON.stringify(f.state().world.eventRuntime), encoded)
        assert.deepEqual(f.state().world.pos, before.world.pos)
    } finally {
        f.store.close()
    }
})

test('SQLite reopens into a new session and scene-loaded10715 reauthorizes genuine admissions without another trigger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-event-b25-')),
        file = path.join(dir, 'world.sqlite')
    let f
    try {
        f = fixture('event-reopen', file)
        f.trigger(101)
        f.step(101, 2)
        const session = f.session.token
        f.store.close()
        f = fixture('event-reopen', file, true)
        assert.notEqual(f.session.token, session)
        assert.equal(f.state().world.eventRuntime, undefined)
        const loaded = f.decoded('MultiCampaignPlayerLoaded')
        assert(loaded.some((p) => p.id === 10715 && p.data.infos.some((i) => i.cfg_id === 101 && i.step === 2)))
        assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        assert.throws(() => f.trigger(104), /current map/)
    } finally {
        f?.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'luruka-event-b25-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('corrupt admission containers and null receipts are configuration errors rather than new-run grants', () => {
    const f = fixture('event-integrity')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.worldEventAdmissions = null
        })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.trigger(101), code(ErrorCode.GameConfig))
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.worldEventAdmissions = { '100:101': null }
        })
        assert.throws(() => f.trigger(101), code(ErrorCode.GameConfig))
        assert.throws(() => f.decoded('MultiCampaignPlayerLoaded'), code(ErrorCode.GameConfig))
    } finally {
        f.store.close()
    }
})

test('legacy generation-less history needs a real new response before it can support a current group condition', () => {
    const f = fixture('event-generation-legacy')
    try {
        f.trigger(101)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.worldEvents['100:101'].generation
            delete s.worldEventAdmissions
            delete s.world.eventRuntime
        })
        assert.throws(() => f.trigger(104), code(ErrorCode.WorldEvCondition))
        assert.equal(f.trigger(101)[0].data.infos[0].step, 1)
        assert.equal(f.state().worldEventAdmissions['100:101'].generation, 1)
        f.step(101, 2)
        assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
    } finally {
        f.store.close()
    }
})

test('admission order corruption cannot issue another accepted run and preserves rollback', () => {
    const f = fixture('event-order-integrity')
    try {
        f.trigger(101)
        f.step(101, 2)
        f.store.transact(f.session.id, 0, (s) => {
            s.worldEventAdmissionOrder = 0
        })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.trigger(104), code(ErrorCode.GameConfig))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('actual101 deadline excludes stale step2 at21600 and21601 without any later101 request', () => {
    for (const offset of [0, 21599, 21600, 21601]) {
        const f = fixture('event-deadline-' + offset)
        try {
            f.trigger(101)
            f.step(101, 2)
            const source = f.state().worldEvents['100:101']
            assert.equal(f.game.tables.find('world_event', 101).overtime, 21600)
            f.time.now = source.begin_time + offset
            assert.equal(f.state().worldEvents['100:101'].expired, false)
            if (offset < 21600) assert.equal(f.trigger(104)[0].data.infos[0].step, 1)
            else {
                assert.throws(() => f.trigger(104), code(ErrorCode.WorldEvCondition))
                assert.equal(f.state().worldEvents['100:104'], undefined)
                assert.equal(f.state().worldEvents['100:101'].step, 2)
                assert.equal(f.state().worldEvents['100:101'].expired, false)
            }
        } finally {
            f.store.close()
        }
    }
})

test('deadline movement prune stays deferred and rolls back the small runtime on codec failure', () => {
    const f = fixture('event-deadline-move')
    try {
        f.trigger(101)
        f.step(101, 2)
        f.store.flushPending()
        f.move(101)
        const before = f.store.pending.get(f.session.id).state,
            prior = before.world.eventRuntime
        const sql = f.store.db.prepare('select state, revision from players where account_id=?').get(f.session.id)
        const changes = f.store.db.prepare('select total_changes() as n').get().n
        f.time.now = before.worldEvents['100:101'].begin_time + 21600
        const encode = f.game.protocol.encode,
            type = f.game.protocol.byName.get('CSProtoStateUpdateBC').rsp
        f.game.protocol.encode = function (t, value) {
            if (t === type) throw Error('deadline prune codec failure')
            return encode.call(this, t, value)
        }
        try {
            assert.throws(() => f.move(101), /deadline prune codec failure/)
        } finally {
            f.game.protocol.encode = encode
        }
        assert.equal(f.store.pending.get(f.session.id).state, before)
        assert.equal(before.world.eventRuntime, prior)
        f.move(101)
        assert.equal(f.state().world.eventRuntime.entries.length, 0)
        assert.equal(f.state().worldEvents['100:101'].expired, false)
        assert.deepEqual(
            f.store.db.prepare('select state, revision from players where account_id=?').get(f.session.id),
            sql,
        )
        assert.equal(f.store.db.prepare('select total_changes() as n').get().n, changes)
    } finally {
        f.store.close()
    }
})

test('SQLite loaded replay excludes expired101, while real zero-overtime104 admission has no invented TTL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-event-deadline-')),
        file = path.join(dir, 'world.sqlite')
    let f
    try {
        f = fixture('event-deadline-reopen', file)
        f.trigger(101)
        f.step(101, 2)
        const begin = f.state().worldEvents['100:101'].begin_time
        f.store.close()
        f = fixture('event-deadline-reopen', file, true)
        f.time.now = begin + 21600
        const loaded = f.decoded('MultiCampaignPlayerLoaded')
        assert(!loaded.some((p) => p.id === 10715 && p.data.infos.some((i) => i.cfg_id === 101)))
        assert.throws(() => f.trigger(104), code(ErrorCode.WorldEvCondition))
    } finally {
        f?.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'luruka-event-deadline-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
    const zero = fixture('event-zero-overtime')
    try {
        zero.trigger(101)
        zero.step(101, 2)
        zero.trigger(104)
        assert.equal(zero.game.tables.find('world_event', 104).overtime, 0)
        zero.time.now += 21601
        assert.equal(zero.trigger(104)[0].data.infos[0].step, 1)
    } finally {
        zero.store.close()
    }
})
