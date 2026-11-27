import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentCommissionMilestone } from './next996001-runner.js'
import { preparedSystemAccess } from '../src/system-access.js'
import { taskSnapshot } from '../src/tasks.js'
import { currentEntrustInputModel, totalExperience } from './current-entrust-input-model.js'

// Genuine normal791 prerequisite, then actual commission stars/menu unlock,
// paid material victories/XP/level gate. No level, record, asset or GM injection.
// HP deltas and movement remain explicit client-input models, not Unity AI.
export async function reachCurrent106014({ outputDirectory, afterUnlock } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-reach106014-')),
        runs = [],
        unlocks = [],
        proof = { before: null, final: null }
    await runCurrentCommissionMilestone({
        outputDirectory: directory,
        afterCommission({ f, driver, observer }) {
            assert.equal(f.requestCount(), 791)
            const { finish: finishInput, stamina } = currentEntrustInputModel(f, driver)
            const finish = (id, kind, pay) => runs.push(finishInput(id, kind, pay))
            try {
                const first = f.state()
                proof.before = {
                    requests: f.requestCount(),
                    level: first.player.basic_info.lv,
                    exp: first.player.basic_info.exp,
                    stamina: String(stamina()),
                }
                assert.equal(first.player.basic_info.lv, 8)
                assert.equal(taskSnapshot(f.tables, first).next_main_id, 106014)
                assert.equal(preparedSystemAccess(f.tables, first, 1734), false)
                finish(2, undefined, false)
                assert.equal(preparedSystemAccess(f.tables, f.state(), 1734), false)
                finish(3, undefined, false)
                assert.equal(preparedSystemAccess(f.tables, f.state(), 1734), true)
                unlocks.push({ system: 1734, source: 'real entrust3 permanent star', request: f.requestCount() })
                const target = 15,
                    needed =
                        f.tables
                            .get('player_level')
                            .filter((row) => row.id < target)
                            .reduce((sum, row) => sum + row.exp, 0) - totalExperience(f.tables, f.state()),
                    bound = Math.ceil(needed / 300)
                while (f.state().player.basic_info.lv < target) {
                    assert(runs.filter((run) => run.paid).length < bound)
                    assert.equal(taskSnapshot(f.tables, f.state()).next_main_id, 106014)
                    assert(!f.state().tasks.some((row) => row.task_id === 106014))
                    finish(10101, 'material', true)
                }
                assert.equal(f.state().player.basic_info.lv, target)
                assert.equal(f.state().tasks.find((row) => row.task_id === 106014).nodes[0].node_id, 3)
                assert.equal(taskSnapshot(f.tables, f.state()).next_main_id, 0)
                const earned = f.state(),
                    earnedRequests = f.requestCount()
                f.coldLogin()
                assert.equal(f.state().player.basic_info.lv, earned.player.basic_info.lv)
                assert.equal(f.state().player.basic_info.exp, earned.player.basic_info.exp)
                assert.deepEqual(f.state().materialDungeonRecords, earned.materialDungeonRecords)
                assert.equal(f.state().tasks.find((row) => row.task_id === 106014).nodes[0].node_id, 3)
                assert.equal(
                    stamina(),
                    BigInt(earned.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val),
                )
                proof.final = {
                    requests: f.requestCount(),
                    earnedRequests,
                    level: f.state().player.basic_info.lv,
                    exp: f.state().player.basic_info.exp,
                    stamina: String(stamina()),
                    runs: runs.length,
                    paidRuns: runs.filter((run) => run.paid).length,
                    task: 106014,
                    node: 3,
                }
                const result = afterUnlock?.({ f, driver, observer, runs })
                assert(!result?.then, 'Unlock continuation must run synchronously')
            } finally {
                fs.writeFileSync(
                    path.join(directory, 'reach106014.json'),
                    JSON.stringify({ ...proof, unlocks, runs }, null, 2) + '\n',
                )
            }
        },
    })
    return { directory, ...proof }
}
