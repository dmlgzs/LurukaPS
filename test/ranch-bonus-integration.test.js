import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchBonusFile, ranchProduction, earnRanchPending } from './ranch-bonus-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

const ranch = (f) => f.state().home.ranches[201]
function collect(f) {
    for (let i = 0; i < 4; i++) {
        const ids = ranch(f).drops.map((row) => row.guid)
        if (!ids.length) return
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: ids })
    }
    throw Error('Unbounded collect')
}
const pendingFromRealTicks = earnRanchPending

test('new Game tick observes pending-only room without producers; full idle does not save and recovery codec/SQL preserve the sealed source', () => {
    const temp = ranchBonusFile(),
        f = ranchBonusFixture('ranch-pending-tick', { file: temp.file })
    let encode
    try {
        const pending = pendingFromRealTicks(f)
        f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: '0', work_type: 1, out_hub: true })
        const revision = () =>
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        const full = revision()
        f.elapse(1)
        assert.deepEqual(f.tick(), [])
        assert.deepEqual(revision(), full)
        // Recovery input only frees a persisted slot; the two bonus facts above
        // were earned by actual ticks, not imported or reconstructed.
        f.edit((state) => {
            state.home.ranches[201].drops.shift()
        })
        const savedState = f.state(),
            originalPending = { state: savedState, revision: f.store.load(f.session.id).revision }
        f.store.pending.set(f.session.id, originalPending)
        const before = revision()
        encode = f.protocol.encode
        f.protocol.encode = function (type, ...args) {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('ranch-idle-codec')
            return encode.call(this, type, ...args)
        }
        assert.throws(() => f.tick(), /ranch-idle-codec/)
        assert.strictEqual(f.store.pending.get(f.session.id), originalPending)
        assert.deepEqual(revision(), before)
        assert.deepEqual(originalPending.state.home.ranches[201].bonus.pendingBonus, pending)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER ranch_idle_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ranch-idle-sql'); END",
        )
        assert.throws(() => f.tick(), /ranch-idle-sql/)
        assert.strictEqual(f.store.pending.get(f.session.id), originalPending)
        assert.deepEqual(revision(), before)
        f.store.db.exec('DROP TRIGGER ranch_idle_abort')
        f.setRoll(() => {
            throw Error('Sealed pending cannot consume RNG')
        })
        const packets = f.tick()
        assert(packets.some((row) => row.id === 6102))
        assert.equal(ranch(f).bonus.pendingBonus.length, 1)
        assert.equal(ranch(f).drops.at(-1).guid, pending[0].guid)
        assert.equal(ranch(f).drops.at(-1).pet_guid, pending[0].pet_guid)
        assert.equal(ranch(f).drops.at(-1).drop_id, pending[0].drop_id)
        f.reopen()
        assert.equal(ranch(f).bonus.pendingBonus[0].guid, pending[1].guid)
    } finally {
        if (encode) f.protocol.encode = encode
        f.store.db.exec('DROP TRIGGER IF EXISTS ranch_idle_abort')
        try {
            f.close()
        } finally {
            temp.close()
        }
    }
})
test('actual6161 release publishes a sealed currency source before its empty ACK, keeps source pet after unassignment, and6160 can grant it directly', () => {
    const f = ranchBonusFixture('ranch-auto-release')
    try {
        f.setRoll((maximum) => (maximum === 2160 ? 1000 : 0))
        const pending = pendingFromRealTicks(f)
        assert.deepEqual(pending[0].item, { itemtype: 10, itemid: 103, itemnum: 5000 })
        f.harvestWorker()
        f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: '0', work_type: 1, out_hub: true })
        const guid = ranch(f).drops[0].guid
        const packets = f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: guid })
        const visible = ranch(f).drops.find((row) => row.guid === pending[0].guid)
        assert.deepEqual(visible.item, pending[0].item)
        assert.equal(visible.pet_guid, f.pets[0])
        assert.equal(visible.drop_id, 1056)
        assert(packets.findIndex((row) => row.id === 6102) < packets.findIndex((row) => row.id === 6161))
        const before = BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 103)?.attr_val ?? '0')
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [visible.guid] })
        assert.equal(
            BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 103).attr_val),
            before + 5000n,
        )
        assert.equal(ranch(f).bonus.pendingBonus.length, 0)
    } finally {
        f.close()
    }
})
test('real10020 upgrade preserves50 raw units without a gift; the next current unit cycle grants one bonus and retains12', () => {
    const f = ranchBonusFixture('ranch-real-research')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 55
            const seen = new Set()
            const add = (id) => {
                if (seen.has(id)) return
                seen.add(id)
                const tree = f.tables.find('home_technology_tree', id)
                for (const parent of String(tree.pretechnologyTypeId || '')
                    .split('|')
                    .filter(Boolean)
                    .map(Number))
                    add(parent)
                state.home.technology.levels[id] = { level: 1, isOpened: true }
            }
            add(20113) // Legitimate historical prerequisite fixture, not new bonus facts.
        })
        f.assign()
        const oneCycle = () => {
            f.setRoll(() => 0)
            const due = Math.min(...ranch(f).product_pets.flatMap((slot) => slot.drop_times.map((clock) => clock.time)))
            f.elapse(due - f.now())
            f.tick()
            collect(f)
        }
        for (let i = 0; i < 50 / ranchProduction(f).units; i++) oneCycle()
        assert.equal(ranch(f).bonus.families[3006].creditUnits, 50)
        const epoch = ranch(f).bonus.epoch,
            next = ranch(f).nextDropGuid
        f.call('HomeTechnologyLevelUp', { type: 2, subType: 22048 })
        assert.equal(ranch(f).bonus.families[3006].technologyId, 2204801)
        assert(ranch(f).bonus.epoch > epoch)
        assert.equal(ranch(f).bonus.families[3006].creditUnits, 50)
        assert.equal(ranch(f).nextDropGuid, next)
        oneCycle()
        assert.equal(ranch(f).bonus.families[3006].creditUnits, 12)
        assert.equal(ranch(f).nextDropGuid, next + ranchProduction(f).rows.length + 1) // Current base instances plus one sealed bonus.
    } finally {
        f.close()
    }
})
test('two actual accounts ranch201 stay isolated; two legal producers contribute in stable slot order within one ranch', () => {
    const temp = ranchBonusFile(),
        first = ranchBonusFixture('ranch-isolate-a', { file: temp.file }),
        second = ranchBonusFixture('ranch-isolate-b', { file: temp.file })
    try {
        first.technologies([2204801])
        first.assign()
        first.assign(first.pets[1], 2)
        second.technologies([2204801])
        second.assign()
        first.elapse(ranchProduction(first).period)
        first.tick()
        assert.equal(ranch(first).drops.length, 4)
        assert.deepEqual(
            ranch(first).drops.map((row) => row.pet_guid),
            [first.pets[0], first.pets[0], first.pets[1], first.pets[1]],
        )
        assert.equal(
            ranch(first).bonus.families[3006].creditUnits,
            ranch(first).drops.reduce((n, row) => n + row.item.itemnum, 0),
        )
        assert.equal(ranch(second).bonus.families[3006].creditUnits, 0)
        assert.equal(ranch(second).drops.length, 0)
        // Only one current blockType2 exists; a second same-account official
        // ranch entrance is not invented for this isolation test.
        assert.equal(first.tables.get('home_block').filter((row) => row.blockType === 2).length, 1)
    } finally {
        try {
            first.close()
            second.close()
        } finally {
            temp.close()
        }
    }
})
