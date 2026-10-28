import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'
import { noviceDuelVictoryValue, noviceDuelVictoryRule } from '../src/novice-duel-victory.js'
import { Store } from '../src/store.js'

const value = (f, area = 1, stars = 0) => noviceDuelVictoryValue(f.state(), area, stars)

test('new NPC runs count real victories once, with current-run stars and no first-clear backfill', () => {
    const f = noviceDuelFixture('novice-source-wins')
    try {
        assert(noviceDuelVictoryRule(f.tables, [13053, 1, 3, 8]))
        assert(!noviceDuelVictoryRule(f.tables, [13053, 0, 3, 8]))
        assert(!noviceDuelVictoryRule(f.tables, [13053, 1, 2, 8]))
        f.enter(1001)
        assert.equal(value(f), 0)
        f.win()
        assert.equal(value(f), 1)
        assert.equal(value(f, 1, 3), 0)
        const generation = f.state().combat.npcDuel.generation
        const receipt = structuredClone(f.state().combat.npcDuel.noviceVictoryReceipt)
        f.call('KiboDuelBattleFinish', { status: 1 })
        f.tick()
        f.relogin()
        assert.deepEqual(f.state().combat.npcDuel.noviceVictoryReceipt, receipt)
        assert.equal(value(f), 1)
        f.call('MultiCampaignQuit')
        f.enter(2001)
        assert(f.state().combat.npcDuel.generation > generation)
        f.win()
        assert.equal(value(f), 2)
        assert.equal(value(f, 1, 3), 1)
        f.call('MultiCampaignQuit')
        f.enter(2001)
        f.advance(80)
        f.win()
        assert.equal(f.state().combat.npcDuel.result.star, 3)
        assert.equal(f.state().kiboDuelRecords[2001].star, 7)
        assert.equal(value(f), 3)
        assert.equal(value(f, 1, 3), 1, 'old OR best cannot turn this two-star run into three stars')
    } finally {
        f.close()
    }
})

test('a real area2 win, surrender and old completed result remain distinct sources', () => {
    const f = noviceDuelFixture('novice-source-domains')
    try {
        f.enter(2041)
        f.win()
        assert.equal(value(f, 2), 1)
        assert.equal(value(f, 2, 3), 1)
        assert.equal(value(f), 0)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.noviceDuelVictory
            delete s.combat.npcDuel.noviceVictoryReceipt
        })
        f.relogin()
        f.call('KiboDuelBattleFinish', { status: 1 })
        assert.equal(value(f, 2), 0, 'legacy completed runs are not retroactive events')
        f.call('MultiCampaignQuit')
        f.enter(2001)
        f.call('KiboDuelSurrender')
        assert.equal(value(f), 0)
        assert.equal(f.state().combat.npcDuel.noviceVictoryReceipt, undefined)
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`actual victory ${failure} failure rolls back the pending source and retries once, then survives SQLite reopen`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novice-source-')),
            file = path.join(dir, 'state.sqlite'),
            f = noviceDuelFixture('novice-source-' + failure, { file })
        let original
        try {
            f.enter(2001)
            f.prepareWin()()
            const pending = f.store.pending.get(f.session.id),
                before = structuredClone(f.state()),
                saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('novice-codec-failure')
                    return original.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER novice_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'novice-sql-failure'); END",
                )
            assert.throws(() => f.tick(), /novice-(codec|sql)-failure/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved,
            )
            if (failure === 'codec') f.game.packet = original
            else f.store.db.exec('DROP TRIGGER novice_fail')
            f.tick()
            assert.equal(value(f, 1, 3), 1)
            f.call('KiboDuelBattleFinish', { status: 1 })
            assert.equal(value(f), 1)
            const id = f.session.id
            f.close()
            const reopened = new Store(file)
            try {
                assert.equal(noviceDuelVictoryValue(reopened.load(id).state, 1, 3), 1)
            } finally {
                reopened.close()
            }
        } finally {
            if (original) f.game.packet = original
            f.close()
            const target = path.resolve(dir)
            assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
            assert(path.basename(target).startsWith('novice-source-'))
            fs.rmSync(target, { recursive: true, force: true })
        }
    })
}
