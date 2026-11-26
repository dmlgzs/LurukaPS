import test from 'node:test'
import assert from 'node:assert/strict'
import { homeCondition } from '../src/home-grid.js'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'

test('15017 uses the current HomeLevelNewBase level independently of player level and legacy home stage', () => {
    const state = { player: { basic_info: { lv: 99 } }, home: { level: 17, stage: 1 } }
    assert.equal(homeCondition('15017#18', state), false)
    state.home.level = 18
    state.player.basic_info.lv = 1
    assert.equal(homeCondition('15017#18', state), true)
    assert.equal(homeCondition('11009#2', state), false)
    state.home.stage = 2
    state.home.level = 1
    assert.equal(homeCondition('11009#2', state), true)
    assert.equal(homeCondition('15017#18', state), false)
})

test('all current building capacity level conditions follow the current client inclusive threshold', () => {
    const tables = new Tables(configuration().tables)
    const rows = tables.get('home_building_num').filter((row) => /^15017#\d+$/.test(row.unlockCondition))
    assert(rows.length > 50)
    assert.equal(
        rows.filter((row) => row.groupId === 2033).reduce((sum, row) => sum + row.addNum, 0),
        50,
    )
    for (const row of rows) {
        const threshold = Number(row.unlockCondition.split('#')[1])
        const state = { player: { basic_info: { lv: 99 } }, home: { level: threshold - 1, stage: 2 } }
        assert.equal(homeCondition(row.unlockCondition, state), false, `before ${row.id}`)
        state.home.level = threshold
        assert.equal(homeCondition(row.unlockCondition, state), true, `at ${row.id}`)
        state.home.level++
        assert.equal(homeCondition(row.unlockCondition, state), true, `after ${row.id}`)
    }
})
