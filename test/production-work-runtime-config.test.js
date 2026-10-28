import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration, loadProductionWorkPolicy } from '../src/config.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
import reviewPolicy from '../configs/production-work-policy-review.json' with { type: 'json' }
import runtimePolicy from '../configs/production-work-policy.json' with { type: 'json' }

function temp() {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'production-policy-b295-'))
    return {
        dir,
        close: () => {
            assert.equal(path.dirname(path.resolve(dir)), parent)
            fs.rmSync(dir, { recursive: true, force: true })
        },
    }
}
const approved = () => ({
    ...structuredClone(reviewPolicy),
    reviewOnly: false,
    humanApproved: true,
    runtimeDefaultEnabled: true,
})

test('the adopted default model preserves the reviewed v2 parameters and activates real server startup', async () => {
    const keys = ['AZUR_PRODUCTION_WORK_POLICY_FILE', 'LURUKAPS_PRODUCTION_WORK_POLICY_FILE'],
        previous = keys.map((key) => [key, process.env[key]])
    let server
    try {
        for (const key of keys) delete process.env[key]
        const config = configuration()
        assert.deepEqual(runtimePolicy, approved())
        assert.deepEqual(config.productionWorkPolicy, runtimePolicy)
        server = await startServer(
            {
                ...config,
                database: ':memory:',
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
            },
            { log() {}, warn() {}, error() {} },
        )
        assert.deepEqual(server.game.productionWorkPolicy, runtimePolicy)
    } finally {
        if (server) await server.close()
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

test('runtime policy loading preserves absence and refuses the unapproved review draft', () => {
    const f = temp()
    try {
        const file = path.join(f.dir, 'policy.json')
        assert.equal(loadProductionWorkPolicy(file, { optional: true }), undefined)
        assert.throws(() => loadProductionWorkPolicy(file), /ENOENT/)
        fs.writeFileSync(file, JSON.stringify(reviewPolicy))
        assert.throws(() => loadProductionWorkPolicy(file), /not been approved/)
        const policy = approved()
        fs.writeFileSync(file, JSON.stringify(policy))
        assert.deepEqual(loadProductionWorkPolicy(file), policy)
    } finally {
        f.close()
    }
})

test('runtime policy file uses project namespace precedence and malformed drafts cannot silently disable a requested model', () => {
    const f = temp(),
        keys = ['AZUR_PRODUCTION_WORK_POLICY_FILE', 'LURUKAPS_PRODUCTION_WORK_POLICY_FILE'],
        previous = keys.map((key) => [key, process.env[key]])
    try {
        const first = path.join(f.dir, 'first.json'),
            second = path.join(f.dir, 'second.json'),
            one = approved(),
            two = { ...approved(), unitBudgetMultiplier: 2 }
        fs.writeFileSync(first, JSON.stringify(one))
        fs.writeFileSync(second, JSON.stringify(two))
        for (const key of keys) delete process.env[key]
        process.env.AZUR_PRODUCTION_WORK_POLICY_FILE = first
        assert.equal(configuration().productionWorkPolicy.unitBudgetMultiplier, 1)
        process.env.LURUKAPS_PRODUCTION_WORK_POLICY_FILE = second
        assert.equal(configuration().productionWorkPolicy.unitBudgetMultiplier, 2)
        fs.writeFileSync(second, JSON.stringify(reviewPolicy))
        assert.throws(() => configuration(), /not been approved/)
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        f.close()
    }
})

test('real loopback server forwards an explicitly selected policy while omitted policy preserves legacy startup', async () => {
    const config = {
            ...configuration(),
            database: ':memory:',
            host: '127.0.0.1',
            publicHost: '127.0.0.1',
            gamePort: 0,
            httpPort: 0,
        },
        logger = { log() {}, warn() {}, error() {} },
        policy = approved()
    const server = await startServer({ ...config, productionWorkPolicy: policy }, logger)
    try {
        assert.strictEqual(server.game.productionWorkPolicy, policy)
    } finally {
        await server.close()
    }
    const legacyConfig = { ...config }
    delete legacyConfig.productionWorkPolicy
    const legacy = await startServer(legacyConfig, logger)
    try {
        assert.equal(legacy.game.productionWorkPolicy, undefined)
    } finally {
        await legacy.close()
    }
})

test('unsupported runtime semantics fail before creating the configured SQLite file or listeners', async () => {
    const f = temp()
    try {
        const database = path.join(f.dir, 'must-not-be-created.sqlite'),
            config = {
                ...configuration(),
                database,
                host: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                productionWorkPolicy: { ...approved(), overflow: 'invented-remainder' },
            }
        await assert.rejects(
            () => startServer(config),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.equal(fs.existsSync(database), false)
    } finally {
        f.close()
    }
})
