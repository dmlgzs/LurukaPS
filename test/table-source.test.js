import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTable } from '../src/table-source.js'
import { configuration, base } from '../src/config.js'
import { activityTables } from '../src/activity-tables.js'
import { productionTables } from '../src/production-tables.js'
import { ornamentValueTables } from '../src/ornament-values.js'
import { soulEssenceValue } from '../src/soul-values.js'
import { gachaTables } from '../src/gacha-tables.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { mallTableRow } from '../src/mall-schedule.js'
import { battlePassRow } from '../src/battle-pass.js'

test('default table location is the sibling 1.0.0 export and explicit environment overrides remain supported', () => {
    const previous = [process.env.LURUKAPS_TABLES, process.env.AZUR_TABLES]
    try {
        delete process.env.LURUKAPS_TABLES
        delete process.env.AZUR_TABLES
        assert.equal(configuration().tables, path.resolve(base, '../Tables/Tables'))
        process.env.AZUR_TABLES = 'legacy-explicit-directory'
        assert.equal(configuration().tables, 'legacy-explicit-directory')
        process.env.LURUKAPS_TABLES = 'current-explicit-directory'
        assert.equal(configuration().tables, 'current-explicit-directory')
    } finally {
        for (const [index, name] of ['LURUKAPS_TABLES', 'AZUR_TABLES'].entries()) {
            if (previous[index] === undefined) delete process.env[name]
            else process.env[name] = previous[index]
        }
    }
})

test('table reads isolate directories, preserve data types, and never substitute a legacy missing table', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-table-source-'))
    const directories = ['first', 'second'].map((name) => path.join(root, name))
    try {
        for (const directory of directories) fs.mkdirSync(directory)
        const first = [{ id: '9223372036854775807', name: '', ratio: 0.125, flag: 0 }]
        fs.writeFileSync(path.join(directories[0], 'hero.json'), JSON.stringify(first))
        fs.writeFileSync(path.join(directories[1], 'hero.json'), JSON.stringify([{ id: 2 }]))
        fs.writeFileSync(path.join(directories[0], 'empty.json'), '[]')
        fs.writeFileSync(path.join(directories[0], 'invalid.json'), '{}')
        assert.deepEqual(readTable('hero', directories[0]), first)
        assert.deepEqual(readTable('hero', directories[1]), [{ id: 2 }])
        assert.deepEqual(readTable('empty', directories[0]), [])
        assert.throws(() => readTable('common_item', directories[0]), { code: 'ENOENT' })
        assert.throws(() => readTable('invalid', directories[0]), /Invalid table/)
        assert.throws(() => readTable('../hero', directories[0]), /Invalid table name/)
    } finally {
        for (const directory of directories) {
            for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name))
            fs.rmdirSync(directory)
        }
        fs.rmdirSync(root)
    }
})

test('former snapshot adapters honor the supplied tables without injecting CBT3 rows or numeric overrides', () => {
    const row = { id: 1, smeltReturn: 'current', attribute: 7 }
    const external = { get: () => [row], find: (name, id) => ({ name, id }) }
    for (const adapt of [activityTables, productionTables, ornamentValueTables]) assert.equal(adapt(external), external)
    assert.deepEqual(new WorldObjectCatalog(external).get('worldmap_100'), [row])
    assert.deepEqual(soulEssenceValue(external, row, 3), { name: 'soulessence_value', id: 7003 })
})

test('gacha indices retain non-id primary keys and stay isolated between supplied table providers', () => {
    const provider = (name) => ({
        get: (table) => [{ gachaId: 10, guaranteeId: 20, name, table }],
        find: () => ({ ordinary: true }),
    })
    const first = gachaTables(provider('first'))
    const second = gachaTables(provider('second'))
    assert.equal(first.find('gacha', 10).name, 'first')
    assert.equal(second.find('gacha', 10).name, 'second')
    assert.equal(first.find('gacha_guarantee', 20).name, 'first')
    assert.deepEqual(first.find('other', 1), { ordinary: true })
    assert.equal(gachaTables(first), first)
})

test('CBT3 field corrections do not rewrite current schedule values', () => {
    const goods = { goodsId: 20302, timelimit: 30001 }
    const pass = { id: 1001, startTime: '20260601-040000', endTime: '20261014-035959' }
    assert.deepEqual(mallTableRow('mall_pay_goods', goods), goods)
    assert.deepEqual(battlePassRow('battle_pass', pass), pass)
})

test('runtime source code has no bundled table snapshot references', () => {
    const source = fileURLToPath(new URL('../src/', import.meta.url))
    function check(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) check(file)
            else if (entry.name.endsWith('.js')) {
                assert.doesNotMatch(
                    fs.readFileSync(file, 'utf8'),
                    /configs\/(?:[\w-]*tables(?:-builtin)?|[\w-]*values|pet-learning)\//,
                    file,
                )
                assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /configs\/kibo-tour-tables\.json/, file)
                assert.doesNotMatch(
                    fs.readFileSync(file, 'utf8'),
                    /configs\/(?:mall-table|home-exchange-price|journey|achievement|battle-pass)-overrides\.json|configs\/repeat-favor-roster-heroes\.json/,
                    file,
                )
            }
        }
    }
    check(source)
})
