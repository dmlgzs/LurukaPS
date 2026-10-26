import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'

test('legacy ending must satisfy original finish attribute condition and cannot unlock its forged party solely from a complete shape', () => {
    const f = fixture('permanent-condition-v2')
    try {
        f.start()
        f.complete()
        f.store.transact(f.session.id, 0, (s) => {
            const e = s.activities[60001],
                good = e.growup.end_data.complete_end[0],
                bad = structuredClone(good)
            delete e.growupPermanent
            bad.id = 102
            bad.attrs.forEach((x) => {
                x.attr_value = 0
            })
            bad.chrs = [{ assist_char_id: 105, bond: 5, is_bond_train: false }]
            bad.trails[2].trail_id = 302
            bad.trails.forEach((x) => {
                x.guid = String((BigInt(f.session.id) << 32n) | 999n)
            })
            assert.equal(
                f.game.activities.growup.condition(
                    f.tables.get('game_events_cul_end').find((x) => x.endingId === 102 && x.systemId === 60001)
                        .condition,
                    { growup_train_attr: bad.attrs },
                ),
                false,
            )
            e.growup.end_data.complete_end.push(bad)
        })
        const before = structuredClone(f.g().end_data)
        f.call('ActivityGet')
        const ledger = f.state().activities[60001].growupPermanent
        assert.deepEqual(ledger.unlocked, [100])
        assert.equal(ledger.migration.skipped.length, 1)
        assert.match(ledger.migration.skipped[0].reason, /ending conditions/)
        assert.deepEqual(f.g().end_data, before)
    } finally {
        f.store.close()
    }
})
