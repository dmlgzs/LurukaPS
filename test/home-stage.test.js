import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { homePayload, ensureHome } from '../src/home.js'
import { reconcileHomeStage } from '../src/home-stage.js'
import { homeCondition } from '../src/home-grid.js'
import { grantRewards } from '../src/rewards.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function state() {
    return {
        player: {
            basic_info: { lv: 32, home_lv: 6, gold: 0, diamond: 0 },
            attr_infos: { attrs: [{ attr_id: 1003, attr_val: '1400' }] },
            sbag_infos: { items: [] },
            heros_info: { heros: [] },
        },
        home: {
            level: 6,
            exp: 40,
            experienceVersion: 1,
            experienceTotal: '1400',
            levelRewardedThrough: 6,
            inventory: [],
            builds: [],
            shortcuts: [],
            wishlist: [],
        },
        tasks: [{ task_id: 400001, finish_nodes: [1] }],
        taskRecords: [],
    }
}
test('repairs the affected level-6 save: fixed scenery uses stage 1 while cultivation stays level 6', () => {
    const s = state()
    const payload = homePayload(tables, s)
    const wire = protocol.decode('SCHomeSync', protocol.encode('SCHomeSync', payload))
    assert.equal(wire.home_lv, 1)
    assert.equal(wire.home_level_new_base.level, 6)
    assert.equal(wire.home_level_new_base.exp, 40)
    assert.equal(s.player.basic_info.home_lv, 1)
    assert.equal(s.home.experienceTotal, '1400')
    assert.equal(homeCondition('11009|2', s), false)
    const revision = s.homeRevision
    assert.equal(reconcileHomeStage(tables, s), false)
    assert.equal(s.homeRevision, revision)
})
test('only the configured expansion task node unlocks stage 2, including archived completion', () => {
    const s = state()
    ensureHome(tables, s)
    s.tasks[0].finish_nodes.push(6)
    assert.equal(reconcileHomeStage(tables, s), true)
    assert.equal(homePayload(tables, s).home_lv, 2)
    assert.equal(homeCondition('11009|2', s), true)
    s.tasks = []
    s.taskRecords = [{ task_id: 400001, count: 1 }]
    assert.equal(reconcileHomeStage(tables, s), false)
    assert.equal(s.home.level, 6)
})
test('cultivation level-up and old EXP-ledger migration cannot select a nonexistent scene stage', () => {
    const s = state()
    grantRewards(tables, s, [{ itemtype: 10, itemid: 1003, itemnum: 1000 }])
    assert.ok(s.home.level > 6)
    assert.equal(homePayload(tables, s).home_lv, 1)
    delete s.home.experienceVersion
    assert.equal(homePayload(tables, s).home_lv, 1)
    assert.equal(s.home.experienceTotal, '2400')
})
