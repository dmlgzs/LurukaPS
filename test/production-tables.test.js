import { readTable } from '../src/table-source.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { productionTables } from '../src/production-tables.js'

test('all production recipes use the extracted current client table without modifying external exports', () => {
    const base = new Tables(configuration().tables),
        external = Object.create(base)
    const stale = base
        .get('products')
        .map((row) => (row.id === 710018 ? { ...row, material: '3#300000#15|3#303000#5|10#103#300' } : row))
    external.get = (name) => (name === 'products' ? stale : base.get(name))
    external.find = (name, id) => (name === 'products' ? stale.find((row) => row.id === id) : base.find(name, id))
    const tables = productionTables(external)
    const expected = readTable('products')
    assert.deepEqual(tables.get('products'), expected)
    assert.equal(expected.length, 426)
    assert.equal(productionTables(external), tables)
    assert.equal(productionTables(tables), tables)
    assert.equal(tables.get('game'), external.get('game'))
    assert.match(external.find('products', 710018).material, /10#103#300/)
    assert.equal(tables.find('products', 710018).material, '3#300000#15|3#303000#5')
    for (const id of [710000, 710001, 710018, 710019, 710042, 710044])
        assert.doesNotMatch(tables.find('products', id).material, /10#103#/)
    assert.equal(tables.find('products', 180013).material, '3#350001#10|3#353002#10')
    assert.equal(tables.find('products', 800008).material, '3#353005#5')
    // A current recipe that still charges coins must keep charging them.
    assert.match(tables.find('products', 710010).material, /10#103#600/)
})
