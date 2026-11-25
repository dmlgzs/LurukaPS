import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configuration, base } from '../src/config.js'
import { Tables } from '../src/player.js'
import { tableExportManifest } from '../src/table-source.js'
import { taskManualModel, noviceTaskValue } from '../src/novice-tasks.js'
import { registerNoviceTasks } from '../src/handlers/novice-tasks.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { startServer } from '../src/server.js'

function exported(names, { complete = true, omit = [], invalid = [] } = {}) {
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    const root = fs.mkdtempSync(path.join(base, 'data/task-manual-test-'))
    const directory = path.join(root, 'Tables')
    fs.mkdirSync(directory)
    for (const name of names) {
        if (!omit.includes(name))
            fs.writeFileSync(path.join(directory, name + '.json'), invalid.includes(name) ? '{' : '[]')
    }
    fs.writeFileSync(
        path.join(root, 'tables_index.json'),
        JSON.stringify({
            complete,
            coreTables: names.length,
            totalTables: names.length,
            tables: names.map((name) => ({ name, section: 'core', file: `Tables/${name}.json` })),
        }),
    )
    return {
        tables: new Tables(directory),
        close() {
            for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file))
            fs.rmdirSync(directory)
            fs.unlinkSync(path.join(root, 'tables_index.json'))
            fs.rmdirSync(root)
        },
    }
}
const journeyNames = ['journey_task', 'journey_task_target', 'journey_tab']

test('current manual uses real Journey definitions without registering or inventing legacy novice rewards', () => {
    const fixture = exported(journeyNames)
    try {
        const names = []
        assert.equal(taskManualModel(fixture.tables), 'journey')
        assert.equal(
            registerNoviceTasks((name) => names.push(name), fixture.tables),
            null,
        )
        assert.deepEqual(names, [])
        assert.throws(() => fixture.tables.get('novice_task'), { code: 'ENOENT' })
    } finally {
        fixture.close()
    }
})

test('declared but missing or corrupt data is never mistaken for a retired definition', () => {
    for (const options of [{ omit: ['novice_task'] }, { invalid: ['novice_task'] }]) {
        const fixture = exported(['novice_task', 'novice_task_group'], options)
        try {
            assert.equal(taskManualModel(fixture.tables), 'novice')
            assert.throws(() => registerNoviceTasks(() => {}, fixture.tables))
        } finally {
            fixture.close()
        }
    }
    const brokenCurrent = exported(journeyNames, { omit: ['journey_task_target'] })
    try {
        assert.throws(() => taskManualModel(brokenCurrent.tables), { code: 'ENOENT' })
    } finally {
        brokenCurrent.close()
    }
})

test('incomplete export metadata fails instead of silently selecting a different manual', () => {
    const fixture = exported(journeyNames, { complete: false })
    try {
        assert.throws(() => tableExportManifest(fixture.tables), /Incomplete table export/)
    } finally {
        fixture.close()
    }
})

test('truncated declared catalogs and mismatched file names cannot retire a manual', () => {
    for (const fault of ['count', 'name']) {
        const fixture = exported(journeyNames)
        try {
            const file = path.join(path.dirname(fixture.tables.dir), 'tables_index.json')
            const index = JSON.parse(fs.readFileSync(file))
            if (fault === 'count') index.coreTables++
            else index.tables[0].file = 'Tables/unrelated.json'
            fs.writeFileSync(file, JSON.stringify(index))
            assert.throws(() => taskManualModel(fixture.tables), /table export manifest/)
        } finally {
            fixture.close()
        }
    }
})

test('explicit legacy datasets retain their handlers; unindexed providers still require real legacy data', () => {
    const fixture = exported(['novice_task', 'novice_task_group'])
    try {
        const handlers = []
        const system = registerNoviceTasks((name) => handlers.push(name), fixture.tables)
        assert(system)
        assert.deepEqual(handlers, ['NoviceTaskFinish', 'NoviceTaskFinishGroup'])
        assert.equal(
            taskManualModel({
                get() {
                    throw Error('No table supplied')
                },
            }),
            'novice',
        )
        assert.throws(
            () =>
                registerNoviceTasks(() => {}, {
                    get() {
                        throw Error('No table supplied')
                    },
                }),
            /No table supplied/,
        )
    } finally {
        fixture.close()
    }
})

test('shared achievement values do not load either manual catalog or alter the old claim ledger', () => {
    const tables = {
        get() {
            throw Error('Unexpected table read')
        },
    }
    const state = {
        player: { basic_info: { lv: 17 }, heros_info: { heros: [{ hero_lv: 30 }, { hero_lv: 10 }] } },
        noviceTasks: { claimedTasks: { 101: true }, claimedGroups: { 1: true }, completedTasks: { 101: true } },
    }
    const oldClaims = structuredClone(state.noviceTasks)
    assert.equal(noviceTaskValue(tables, state, { finishCondition: '2004#10' }), 17)
    assert.equal(noviceTaskValue(tables, state, { finishCondition: '13002#30#3' }), 1)
    assert.deepEqual(state.noviceTasks, oldClaims)
})

test('Game constructs with the actual 1.0 tables and retains current Journey request handlers', () => {
    const config = configuration(),
        store = new Store(':memory:')
    try {
        const protocol = new Protocol(config.base)
        const game = new Game(protocol, store, new Tables(config.tables))
        assert.equal(game.taskManualModel, 'journey')
        assert.equal(game.noviceTasks, null)
        for (const id of [9869, 11881, 11882, 11883]) assert(game.handlers.has(id), id)
        for (const name of ['CSProtoNoviceTaskFinish', 'CSProtoNoviceTaskFinishGroup', 'CSProtoShowJourneyStageWindow'])
            assert.equal(game.handlers.has(protocol.byName.get(name)?.id), false)
    } finally {
        store.close()
    }
})

test('service opens loopback ephemeral listeners and serves startup queries without touching a normal save', async () => {
    const config = { ...configuration(), host: '127.0.0.1', database: ':memory:', gamePort: 0, httpPort: 0 }
    const service = await startServer(config, { log() {}, warn() {}, error() {} })
    try {
        assert.equal(service.game.taskManualModel, 'journey')
        assert(service.tcp.address().port > 0)
        const url = `http://127.0.0.1:${service.web.address().port}`
        for (const name of ['getCdnV1', 'preDownloadConfV1', 'getAccountV1']) {
            const result = await fetch(`${url}/version/client/${name}`)
            assert.equal(result.status, 200)
            const payload = await result.json()
            assert.equal(payload.code, 0)
        }
    } finally {
        await service.close()
    }
    assert.equal(service.tcp.listening, false)
    assert.equal(service.web.listening, false)
})
