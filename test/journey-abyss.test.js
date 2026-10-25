import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { clearRoom } from './battle-pass-abyss-fixture.js'
import { journeyModel, journeyValue, journeySnapshot, notifyJourney } from '../src/journey.js'
import { journeyAbyssRule, journeyAbyssValue } from '../src/journey-abyss.js'
import { ErrorCode } from '../src/error-codes.js'
import { Tables } from '../src/player.js'

function fixture(name, file = ':memory:', resume = false) {
    const f = abyssFixture(name, file, resume)
    if (!resume)
        f.store.transact(f.session.id, 0, (state) => {
            const model = journeyModel(f.tables)
            // Only unrelated main-card prerequisites are imported. Neither13111
            // target nor any abyss passed property is fabricated here.
            for (const taskId of [20000, 20001, 20101, 20201, 20301, 20401])
                for (const targetId of model.byTask.get(taskId).ids) {
                    const row = model.byTarget.get(targetId)
                    if (row.tokens[0] !== 13111)
                        state.journey.targets[targetId] = { value: row.targetParam, complete: true, claimed: false }
                }
            state.journey.tasks[20000] = { complete: true, claimed: true }
            state.journey.claimRevision++
        })
    const enter = (id) => {
        f.call('AbyssChallenge', f.request(1, id))
        f.call('AbyssChallengeRealStart')
    }
    return { ...f, enter }
}
const ledger = (f, id) => f.state().journey.targets[id]

test('complete current13111 journey family compiles while13124 and15055 remain explicitly separate', () => {
    const f = fixture('journey-abyss-catalogue')
    try {
        const model = journeyModel(f.tables),
            rows = model.byKind.get(13111)
        assert.equal(rows.length, 2)
        assert(rows.every((row) => row.supported))
        assert.deepEqual(model.sourceAbyssIds, [10001, 10003])
        assert.equal(model.targets.filter((row) => row.supported).length, 149)
        assert.equal(model.referencedTargets.filter((row) => row.supported).length, 133)
        assert.equal(model.byKind.get(13124).length, 6)
        assert(model.byKind.get(13124).every((row) => !row.supported))
        assert(rows.every((row) => journeyValue(f.tables, f.state(), row) === 0))
        for (const tokens of [
            [13111, 0],
            [13111, 999999],
            [13111, 10001, 1],
            [13124, 1, 21],
        ])
            assert.equal(journeyAbyssRule(f.tables, tokens), false)
        const tables = new Tables(f.tables.dir),
            targets = tables.get('journey_task_target').map((row) => ({ ...row }))
        targets.find((row) => row.id === 1520406).targetParam = 2
        tables.cache.set('journey_task_target', targets)
        assert.equal(journeyModel(tables).byTarget.get(1520406).supported, false)
        const state = structuredClone(f.state())
        state.abyss = {
            modes: { 1: { levels: { 10001: { star_num: 3, win_count: 99, pass_level_reward_flag: true } } } },
        }
        assert.equal(journeyAbyssValue(f.tables, state, 10001), 0)
    } finally {
        f.store.close()
    }
})

test('real10001 and10003 room battles produce both journey targets and independent9869 rewards exactly once', () => {
    const f = fixture('journey-abyss-real')
    try {
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [1520406] }),
            (error) => error.code === ErrorCode.JourneyContReward,
        )
        for (const id of [10001, 10002, 10003]) {
            f.enter(id)
            assert.equal(f.state().abyss.modes[1].levels[id].passed, false)
            clearRoom(f)
            assert.equal(f.state().abyss.modes[1].levels[id].passed, true)
            const packets = f.call('AbyssChallengeQuit')
            if (id === 10001 || id === 10003) {
                const target = id === 10001 ? 1520406 : 5040301
                assert.equal(ledger(f, target).value, 1)
                assert(ledger(f, target).complete)
                assert(packets.some((row) => row.id === 11880))
                const reply = f.call('JourneyTaskFinish', { u32s: [target] })
                assert(f.p.decode('Rewards', reply.find((row) => row.id === 9869).payload).rewards.length > 0)
                assert(ledger(f, target).claimed)
                assert.deepEqual(
                    f.p.decode(
                        'Rewards',
                        f.call('JourneyTaskFinish', { u32s: [target] }).find((row) => row.id === 9869).payload,
                    ).rewards,
                    [],
                )
            }
        }
        const value = ledger(f, 1520406).value
        f.enter(10001)
        clearRoom(f)
        f.call('AbyssChallengeQuit')
        assert.equal(ledger(f, 1520406).value, value)
    } finally {
        f.store.close()
    }
})

test('final death and journey reward encoding failures roll back passed, HP, progress and claims', () => {
    const f = fixture('journey-abyss-rollback'),
        encode = f.p.encode
    try {
        f.enter(10001)
        let beforeLast
        f.p.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCAbyssDungeonEndSync') throw Error('journey abyss completion codec')
            return encode.call(this, name, ...args)
        }
        assert.throws(
            () =>
                clearRoom(f, () => {
                    beforeLast = structuredClone(f.state())
                }),
            /journey abyss completion codec/,
        )
        assert.deepEqual(f.state(), beforeLast)
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, false)
        f.p.encode = encode
        clearRoom(f)
        f.call('AbyssChallengeQuit')
        assert(ledger(f, 1520406).complete)
        for (const type of ['SCJourneySync', 'Rewards']) {
            const before = structuredClone(f.state())
            f.p.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('journey abyss reward codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('JourneyTaskFinish', { u32s: [1520406] }), /journey abyss reward codec/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
        }
        f.call('JourneyTaskFinish', { u32s: [1520406] })
        assert(ledger(f, 1520406).claimed)
    } finally {
        f.p.encode = encode
        f.store.close()
    }
})

test('old cache sources coexist with new passed source and steady ordinary callbacks never scan all tasks or abyss records', () => {
    const f = fixture('journey-abyss-cache')
    try {
        const state = structuredClone(f.state()),
            model = journeyModel(f.tables),
            sent = []
        const c = { tables: f.tables, state, now: f.time.now, pushBefore: (name, data) => sent.push({ name, data }) }
        delete state.journey.observedSources.abyss
        notifyJourney(c, 'CSProtoAddChat')
        assert(state.journey.observedSources.abyss)
        assert(Object.hasOwn(state.journey.observedSources, 'entrust'))
        assert(Object.hasOwn(state.journey.observedSources, 'reputation'))
        sent.length = 0
        const targets = model.targets
        model.targets = new Proxy(targets, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) throw Error('whole journey scan')
                return Reflect.get(target, key)
            },
        })
        state.abyss = {
            modes: {
                1: {
                    levels: new Proxy(
                        {},
                        {
                            ownKeys() {
                                throw Error('whole abyss scan')
                            },
                        },
                    ),
                },
            },
        }
        try {
            for (let i = 0; i < 200; i++) notifyJourney(c, 'CSProtoAddChat')
            assert.equal(sent.length, 0)
        } finally {
            model.targets = targets
        }
    } finally {
        f.store.close()
    }
})

test('real cleared journey and claimed receipt persist through SQLite reopen and stay account-local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-abyss-journey-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture('journey-abyss-persist', file)
        f.enter(10001)
        clearRoom(f)
        f.call('AbyssChallengeQuit')
        f.call('JourneyTaskFinish', { u32s: [1520406] })
        f.store.close()
        f = fixture('journey-abyss-persist', file, true)
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, true)
        assert(ledger(f, 1520406).claimed)
        assert.deepEqual(
            f.p.decode(
                'Rewards',
                f.call('JourneyTaskFinish', { u32s: [1520406] }).find((row) => row.id === 9869).payload,
            ).rewards,
            [],
        )
        const other = fixture('journey-abyss-other', file)
        try {
            assert.equal(ledger(other, 1520406).complete, false)
        } finally {
            other.store.close()
        }
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-abyss-journey-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
