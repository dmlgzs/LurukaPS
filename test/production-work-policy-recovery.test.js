import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { productionWorkGameFixture } from './production-work-game-fixture.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/production-work-policy-review.json' with { type: 'json' }
import { workCompare } from '../src/production-work-fractions.js'

const evidence = process.env.LURUKAPS_RECOVERY_PROBE_OUTPUT
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', process.env.LURUKAPS_RECOVERY_PROBE_OUTPUT)
    : null
if (evidence) fs.mkdirSync(evidence, { recursive: true })
const hash = (value) => createHash('sha256').update(value).digest('hex')
const saved = (store, id) => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(id)
function summary(row) {
    return { revision: row.revision, stateSha256: hash(row.state) }
}
function dispatch(game, p, session, name, request, seq = 1) {
    const e = p.byName.get('CSProto' + name)
    return game.dispatch(session, { id: e.id, seq, payload: e.req ? p.encode(e.req, request) : Buffer.alloc(0) })
}
for (const variant of ['active-half', 'orphan-epoch', 'claimed-ledger']) {
    test(`persisted ${variant} without its model rejects login and tick without changing the saved player`, () => {
        const parent = path.resolve(os.tmpdir()),
            dir = fs.mkdtempSync(path.join(parent, 'work-policy-b296-'))
        const file = path.join(dir, 'state.sqlite'),
            name = 'policy-recovery-' + variant
        let f, store
        try {
            f = productionWorkGameFixture(name, { file, satiety: 60 })
            f.start(variant === 'claimed-ledger' ? 1 : 3)
            assert.equal(f.job().seconds, 2)
            f.advance(1)
            assert.equal(workCompare(f.state().home.productionWork.pets[f.workerGuid].balance, { n: '119', d: '2' }), 0)
            if (variant === 'claimed-ledger') {
                f.advance(1)
                f.call('ProductFinish', { guid: 1, is_all: true })
                assert.equal(f.state().home.productionJobs[1].length, 0)
                assert(f.state().home.productionWork)
            } else if (variant === 'orphan-epoch') {
                f.edit((state) => {
                    delete state.home.productionWork
                })
                assert(f.job().workEpoch)
            }
            const id = f.session.id,
                now = f.now() + 10,
                p = f.protocol,
                tables = f.tables,
                worker = f.workerGuid
            f.close()
            f = null
            store = new Store(file)
            const before = saved(store, id),
                game = new Game(p, store, tables, { clock: () => now })
            let loginError, tickError, packets, ticks
            try {
                packets = dispatch(game, p, {}, 'EnterGame', { open_id: name })
            } catch (error) {
                loginError = error
            }
            const afterLogin = saved(store, id)
            try {
                ticks = game.tick(id)
            } catch (error) {
                tickError = error
            }
            const afterTick = saved(store, id)
            if (evidence)
                fs.writeFileSync(
                    path.join(evidence, variant + '.json'),
                    JSON.stringify(
                        {
                            variant,
                            loginError: loginError ? { code: loginError.code, message: loginError.message } : null,
                            tickError: tickError ? { code: tickError.code, message: tickError.message } : null,
                            loginPacketCount: packets?.length ?? null,
                            tickPacketCount: ticks?.length ?? null,
                            before: summary(before),
                            afterLogin: summary(afterLogin),
                            afterTick: summary(afterTick),
                        },
                        null,
                        2,
                    ) + '\n',
                )
            assert.equal(loginError?.code, ErrorCode.GameConfig)
            assert.equal(tickError?.code, ErrorCode.GameConfig)
            assert.deepEqual(afterLogin, before)
            assert.deepEqual(afterTick, before)
            if (variant !== 'orphan-epoch') {
                const restored = new Game(p, store, tables, { clock: () => now, productionWorkPolicy: policy })
                dispatch(restored, p, {}, 'EnterGame', { open_id: name })
                const state = store.load(id).state
                const cost = variant === 'active-half' ? 3 : 1
                assert.equal(workCompare(state.home.productionWork.stats.spent, cost), 0)
                assert.equal(workCompare(state.home.productionWork.pets[worker].balance, 60 - cost), 0)
                assert.equal(state.pets.find((pet) => pet.guid === worker).satiety_val, 60 - cost)
                if (variant === 'active-half') assert.equal(state.home.productionJobs[1][0].workCompleted, 3)
            }
        } finally {
            f?.close()
            store?.close()
            assert.equal(path.dirname(path.resolve(dir)), parent)
            assert(path.basename(dir).startsWith('work-policy-b296-'))
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
}

test('a genuine legacy queue without a typed ledger keeps its no-policy production and claim lifecycle', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        p = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const session = {},
        game = new Game(p, store, tables, { clock: () => now })
    const call = (name, data = {}) => dispatch(game, p, session, name, data, seq++)
    try {
        call('EnterGame', { open_id: 'policy-recovery-legacy' })
        store.transact(session.id, 0, (state) => {
            state.tasks = []
            state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
            state.player.basic_info.lv = 30
            state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
            state.home.technology.levels[11005] = { level: 1, lastTime: 0 }
            state.player.sbag_infos.items = [{ itemid: 300000, itemnum: 1000 }]
        })
        call('ProductStart', { build_guid: 1, product_id: 302001, count: 2 })
        const job = structuredClone(store.load(session.id).state.home.productionJobs[1][0])
        assert.equal(store.load(session.id).state.home.productionWork, undefined)
        assert.equal(job.workEpoch, undefined)
        now += job.seconds * 2
        game.tick(session.id)
        call('ProductFinish', { guid: 1, is_all: true })
        const state = store.load(session.id).state
        assert.equal(state.home.productionJobs[1].length, 0)
        assert.equal(state.home.productionWork, undefined)
        for (const output of job.rewards)
            assert(
                state.player.sbag_infos.items
                    .filter((item) => item.itemid === output.itemid)
                    .reduce((n, item) => n + item.itemnum, 0) >=
                    output.itemnum * 2,
            )
    } finally {
        store.close()
    }
})
