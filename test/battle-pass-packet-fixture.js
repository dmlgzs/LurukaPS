import assert from 'node:assert/strict'
import { battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { prepareBattlePass } from '../src/battle-pass.js'

export const fixtureNow = Date.UTC(2026, 9, 2, 4) / 1000

// A changed task prerequisite may publish exactly one known beforePush. Keep
// every other packet in order, so unexpected messages cannot disappear here.
export function afterBattlePassBeforePush(packets, tables, state, now = fixtureNow) {
    const batches = packets.filter((p) => p.id === 18006)
    assert(batches.length <= 1, 'battle pass task sync must not repeat in a response')
    if (!batches.length) return packets
    assert.equal(packets[0], batches[0], 'task sync must precede the request acknowledgement')
    const prepared = prepareBattlePass(tables, state, now),
        snapshot = battlePassTaskSnapshot(tables, state, now, prepared),
        task = [...snapshot.day_task, ...snapshot.week_task, ...snapshot.forever_task]
    assert.equal(new Set(task.map((r) => r.task_id)).size, task.length)
    assert(task.length > 0)
    assert.deepEqual(batches[0].data.one_task, task)
    assert.deepEqual(batches[0].data.info, {
        battlepass_id: prepared.season.row.id,
        level: prepared.ledger.level,
        exp: prepared.ledger.exp,
        curr_week_exp: prepared.ledger.curr_week_exp,
        pay_state: prepared.ledger.pay_state,
    })
    return packets.slice(1)
}
