import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ranchBonusCatalog } from '../src/ranch-bonus.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const baseId = Number(
    tables
        .get('pet_home_talent')
        .find((row) => row.farmProducts)
        ?.farmProducts.split('|')[0],
)
const technologyId = 2007701

function altered({ drop, params } = {}) {
    return {
        get(name) {
            const rows = tables.get(name)
            return name === 'home_technology' && params !== undefined
                ? rows.map((row) => (row.id === technologyId ? { ...row, buffParams: params } : row))
                : rows
        },
        find(name, id) {
            const row = tables.find(name, id)
            return name === 'home_drop' && id === baseId && drop ? drop(row) : row
        },
    }
}

test('catalog separates missing or malformed base definitions from legal unsupported quantities', () => {
    for (const drop of [() => undefined, (row) => ({ ...row, minValue: NaN }), (row) => ({ ...row, maxValue: -1 })])
        assert.throws(
            () => ranchBonusCatalog(altered({ drop })),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => ranchBonusCatalog(altered({ drop: (row) => ({ ...row, minValue: 3, maxValue: 3 }) })),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
})

test('catalog separates corrupt numeric parameters from a valid unsupported multiplier', () => {
    for (const params of ['NaN#1050#60', '10000#1050#-1'])
        assert.throws(
            () => ranchBonusCatalog(altered({ params })),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => ranchBonusCatalog(altered({ params: '9999#1050#60' })),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    assert.equal(ranchBonusCatalog(altered()).definitions.length, 4)
})
