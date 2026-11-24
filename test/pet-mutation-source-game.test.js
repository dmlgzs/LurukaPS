import test from 'node:test'
import assert from 'node:assert/strict'
import { mainEntrustFixture } from './main-entrust-clear-fixture.js'
import { createPets } from '../src/pets.js'
import { createMutationSourceRuntime } from '../src/pet-mutation-source.js'
import { ErrorCode } from '../src/error-codes.js'
import { weeklyMutationFixture } from './mutation-weekly-fixture.js'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { taskPetPresentation } from '../src/task-pet-presentation.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MutationSourceSkipTag } from '../src/pet-mutation-state.js'

function bind(f) {
    let ids
    f.edit((s) => {
        const pets = createPets(f.tables, s, 500001, 2, 1001, () => 0)
        ids = pets.map((p) => p.guid)
        const manager = s.player.group_mgrs.find((m) => m.type === 1)
        const slots = manager.groups.find((g) => g.id === manager.cur_group).heros
        assert(slots.length >= 2)
        slots[1].hero_id = s.player.heros_info.heros.find((h) => h.guid !== slots[0].hero_id).guid
        for (let i = 0; i < 2; i++) {
            const hero = s.player.heros_info.heros.find((h) => h.guid === slots[i].hero_id)
            const old = s.pets.find((p) => p.guid === hero.pet_id)
            if (old) old.hero_id = '0'
            hero.pet_id = pets[i].guid
            slots[i].pet_id = pets[i].guid
            pets[i].hero_id = hero.guid
            pets[i].mutation_times = 0
        }
    })
    return ids
}
function claim(f, times = 1) {
    return f.call('StaminaBoxGet', { box_id: f.chest().id, times })
}

test('actual ordinary claim without source accepts raw malformed unrelated pending', () => {
    const f = mainEntrustFixture('mutation-baseline-codec')
    try {
        const ids = bind(f)
        f.win(1)
        f.edit((s) => {
            s.pets.find((p) => p.guid === ids[0]).mutation_info = 'bad'
        })
        claim(f, 2)
        assert.equal(f.run().chest_claimed, true)
    } finally {
        f.close()
    }
})

test('source must keep actual primary claim working with one M1 pending and one earning pet', () => {
    const f = mainEntrustFixture('mutation-source-codec')
    try {
        const ids = bind(f)
        f.win(1)
        f.edit((s) => {
            s.pets.find((p) => p.guid === ids[0]).mutation_info = 'bad'
        })
        f.game.rng = () => 0
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        const packets = claim(f, 2)
        assert.equal(f.run().chest_claimed, true)
        const s = f.state()
        assert.equal(s.pets.find((p) => p.guid === ids[0]).mutation_info, 'bad')
        assert.equal(s.pets.find((p) => p.guid === ids[1]).mutation_times, 1)
        assert.equal(Object.keys(s.petMutation.claimResults).length, 1)
        const wire = packets
            .filter((p) => p.id === 6517)
            .flatMap((p) => f.protocol.decode(f.protocol.byId.get(6517).rsp, p.payload).pet_infos.pets)
        assert.deepEqual(
            wire.map((p) => p.guid),
            [ids[1]],
        )
    } finally {
        f.close()
    }
})

const receipts = (f) => Object.values(f.state().petMutation?.claimResults ?? {})
const sequence = (f) =>
    f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('mutation-source-paid-claim:' + f.id())?.value ??
    0

test('real primary claim preserves a classified malformed counter and publishes only the separately credited pet', () => {
    const f = mainEntrustFixture('mutation-bad-counter-real')
    try {
        const ids = bind(f)
        f.win(1)
        f.edit((s) => {
            s.pets.find((p) => p.guid === ids[0]).mutation_times = 'bad'
        })
        f.game.rng = () => 0
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        const packets = claim(f, 2)
        assert.equal(f.run().chest_claimed, true)
        assert.equal(f.state().pets.find((p) => p.guid === ids[0]).mutation_times, 'bad')
        assert.equal(f.state().pets.find((p) => p.guid === ids[1]).mutation_times, 1)
        assert.equal(receipts(f)[0].pets.find((p) => p.pet_guid === ids[0]).tag, MutationSourceSkipTag.CounterInvalid)
        const wire = packets
            .filter((p) => p.id === 6517)
            .flatMap((p) => f.protocol.decode(f.protocol.byId.get(6517).rsp, p.payload).pet_infos.pets)
        assert.deepEqual(
            wire.map((p) => p.guid),
            [ids[1]],
        )
    } finally {
        f.close()
    }
})

test('ordinary/material actual fee callbacks count every current pet, carry remainder and never replay old claims', () => {
    const f = mainEntrustFixture('mutation-paid-routes')
    try {
        const ids = bind(f)
        f.game.rng = () => 0
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        f.win(1)
        let lastCall
        const dispatch = f.game.dispatch.bind(f.game)
        f.game.dispatch = (session, frame) => {
            lastCall = [session, frame]
            return dispatch(session, frame)
        }
        claim(f, 2)
        const saved = f.state(),
            first = receipts(f)[0],
            raw = lastCall
        assert(first.primary.instance_id > 0)
        assert.equal(first.primary.paid_stamina, 60)
        assert.equal(sequence(f), 1)
        for (const id of ids) {
            assert.equal(saved.pets.find((p) => p.guid === id).mutation_times, 1)
            assert.equal(saved.petMutation.pets[id].remainder, 20)
        }
        dispatch(...raw)
        claim(f, 2)
        assert.equal(sequence(f), 1)
        assert.deepEqual(f.state().petMutation, saved.petMutation)
        f.login()
        claim(f, 2)
        assert.equal(sequence(f), 1)
        assert.deepEqual(f.state().petMutation, saved.petMutation)
        f.material.win(30101)
        const box = f.catalog.chest(30101, 'material')
        f.call('StaminaBoxGet', { box_id: box.id, times: 1 })
        assert.equal(sequence(f), 2)
        assert.equal(receipts(f)[1].primary.kind, 'material')
        for (const id of ids) {
            assert.equal(f.state().pets.find((p) => p.guid === id).mutation_times, 2)
            assert.equal(f.state().petMutation.pets[id].remainder, 20)
        }
    } finally {
        f.close()
    }
})

test('actual fee, RNG/codec, receipt persistence, SQL and allocator failures roll back main reward and source together', () => {
    const f = mainEntrustFixture('mutation-atomic-source')
    try {
        bind(f)
        f.win(1)
        f.game.rng = () => 0
        const base = createMutationSourceRuntime()
        f.game.mutationSourceRuntime = base
        f.call('BattleInfoReduce', { uint64_dic: [], battle_info: [], base_time: '0' })
        const pending = f.store.pending.get(f.id()),
            readToken = f.store.readCacheToken(f.id())
        const before = f.state(),
            sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id())
        const assertOld = () => {
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id()),
                sql,
            )
            assert.equal(sequence(f), 0)
            assert.equal(f.store.pending.get(f.id()), pending)
            assert.equal(f.store.readCacheToken(f.id()), readToken)
        }
        const packet = f.game.packet
        f.game.packet = function (name, ...rest) {
            if (name === 'CSProtoPetInfoSync') throw Error('source-wire-fault')
            return packet.call(this, name, ...rest)
        }
        assert.throws(() => claim(f, 2), /source-wire-fault/)
        f.game.packet = packet
        assertOld()
        f.game.mutationSourceRuntime = createMutationSourceRuntime({
            recordMutationSourceReceipt: () => {
                throw Error('source-receipt-fault')
            },
        })
        assert.throws(() => claim(f, 2), /source-receipt-fault/)
        assertOld()
        f.game.mutationSourceRuntime = base
        f.store.db.exec(
            `CREATE TEMP TRIGGER mutation_source_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.id()} BEGIN SELECT RAISE(ABORT,'mutation-source-SQL'); END`,
        )
        assert.throws(() => claim(f, 2), /mutation-source-SQL/)
        f.store.db.exec('DROP TRIGGER mutation_source_abort')
        assertOld()
        const allocate = f.store.nextSequence
        f.store.nextSequence = () => {
            throw Error('Sequence exhausted')
        }
        assert.throws(
            () => claim(f, 2),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assertOld()
        const unknown = Error('unknown-SQL-authority')
        f.store.nextSequence = () => {
            throw unknown
        }
        assert.throws(
            () => claim(f, 2),
            (e) => e === unknown,
        )
        assertOld()
        f.store.nextSequence = allocate
        f.store.db
            .prepare('INSERT INTO sequences(name,value) VALUES(?,?)')
            .run('mutation-source-paid-claim:' + f.id(), 0xffffffff)
        assert.throws(
            () => claim(f, 2),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(sequence(f), 0xffffffff)
        f.store.db.prepare('DELETE FROM sequences WHERE name=?').run('mutation-source-paid-claim:' + f.id())
        claim(f, 2)
        assert.equal(sequence(f), 1)
        assert.equal(receipts(f).length, 1)
        assert.equal(f.run().chest_claimed, true)
    } finally {
        f.close()
    }
})

test('final notification rejects source-only filtering after legitimate subsequent revision, insertion or deletion', () => {
    for (const change of ['revision', 'insert', 'delete']) {
        const f = mainEntrustFixture('mutation-final-delta-' + change)
        try {
            const ids = bind(f)
            f.win(1)
            f.game.rng = () => 0
            f.game.syncOptimization = false
            const base = createMutationSourceRuntime()
            let expected
            f.game.mutationSourceRuntime = {
                ...base,
                complete(c, h) {
                    const result = base.complete(c, h)
                    if (change === 'revision') c.state.petRevision++
                    if (change === 'insert') createPets(c.tables, c.state, 500001, 1, 1001, () => 0)
                    if (change === 'delete') c.state.pets = c.state.pets.filter((p) => p.guid !== ids[0])
                    expected = taskPetPresentation(c.tables, c.state, {
                        pet_infos: { pets: c.state.pets },
                    }).pet_infos.pets.map((p) => p.guid)
                    return result
                },
            }
            const packets = claim(f, 2)
            const payloads = packets
                .filter((p) => p.id === 6517)
                .map((p) => f.protocol.decode(f.protocol.byId.get(6517).rsp, p.payload))
            assert.deepEqual(
                payloads.flatMap((p) => p.pet_infos.pets.map((p) => p.guid)),
                expected,
            )
            if (change === 'delete') assert(payloads.some((p) => p.pet_infos.guid.includes(ids[0])))
        } finally {
            f.close()
        }
    }
})

test('weekly real victory claim counts 40 stamina, excludes 104 quota and free star/challenge rewards', () => {
    const f = weeklyMutationFixture('mutation-weekly-real')
    try {
        const ids = bind(f)
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        const box = f.complete()
        assert.equal(receipts(f).length, 0)
        const beforeStamina = f.balance(3),
            beforeQuota = f.balance(104)
        f.claim(box)
        const receipt = receipts(f)[0]
        assert.equal(receipt.primary.kind, 'weekly')
        assert.equal(receipt.primary.paid_stamina, 40)
        assert.equal(f.balance(3), beforeStamina - 40n)
        assert.equal(f.balance(104), beforeQuota - 1n)
        for (const id of ids) assert.equal(f.state().pets.find((p) => p.guid === id).mutation_times, 1)
        f.claim(box)
        assert.equal(receipts(f).length, 1)
    } finally {
        f.store.close()
    }
})

test('repeat first/free awards earn nothing, then actual paid three shares earn independent 90-unit credit', () => {
    const f = repeatFixture('mutation-repeat-real')
    f.edit = (fn) => f.store.transact(f.session.id, 0, fn)
    try {
        const ids = bind(f)
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '500'
        })
        f.game.rng = () => 0
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        const clear = (restart = false) => {
            f.call(restart ? 'RepeatEventReEnterLevelReq' : 'RepeatEventEnterLevelReq', {
                activity: 10001,
                chapter: 101,
                level: 10101,
                mode: 1,
            })
            f.call('MultiCampaignPlayerLoadFinish')
            const stages = getEntrustCatalog(f.tables).stages(f.state().entrust.run.dungeon_id)
            f.interact(stages[0].row.id)
            for (const stage of stages.slice(1, -1)) f.kill(stage.row.id)
            assert.equal(f.state().entrust.run.battle_complete, true)
        }
        clear()
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(receipts(f).length, 0)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        assert.equal(receipts(f).length, 0)
        assert.equal(
            f.store.db
                .prepare('SELECT value FROM sequences WHERE name=?')
                .get('mutation-source-paid-claim:' + f.session.id),
            undefined,
        )
        clear(true)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 3 })
        assert.equal(receipts(f).length, 1)
        assert.equal(receipts(f)[0].primary.kind, 'repeat')
        assert.equal(receipts(f)[0].primary.paid_stamina, 90)
        for (const id of ids) {
            assert.equal(f.state().pets.find((p) => p.guid === id).mutation_times, 2)
            assert.equal(f.state().petMutation.pets[id].remainder, 10)
        }
    } finally {
        f.store.close()
    }
})

test('actual physical chest claim persists no-success audit and cannot reroll after database reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-mutation-source-'))
    const filename = path.join(directory, 'source.sqlite')
    const name = 'mutation-source-reopen'
    let f = mainEntrustFixture(name, filename)
    try {
        const ids = bind(f)
        f.win(1)
        // A genuine failed 40-unit chance must remain paid and recorded.
        // Only this source RNG boundary is controlled; fee/grant/core/codec/SQL
        // still run through the ordinary Game dispatcher.
        const base = createMutationSourceRuntime()
        let rolls = 0
        f.game.mutationSourceRuntime = {
            ...base,
            complete(c, h) {
                const rng = c.randomInt
                c.randomInt = (maximum) => {
                    assert.equal(maximum, 10000)
                    rolls++
                    return 2000
                }
                try {
                    return base.complete(c, h)
                } finally {
                    c.randomInt = rng
                }
            },
        }
        // First physical claim spends30, retains30 and makes no trial.
        f.interact(f.chest().worldmapid)
        assert.equal(sequence(f), 1)
        assert.equal(rolls, 0)
        f.win(1)
        claim(f, 1)
        assert.equal(rolls, 2)
        assert.equal(sequence(f), 2)
        for (const id of ids) {
            assert.equal(f.state().pets.find((p) => p.guid === id).mutation_times, 0)
            assert.equal(f.state().petMutation.pets[id].remainder, 20)
        }
        const saved = structuredClone(f.state().petMutation)
        assert(receipts(f)[1].pets.every((p) => p.plan.status === 'no-success'))
        f.close()
        f = mainEntrustFixture(name, filename)
        f.game.mutationSourceRuntime = createMutationSourceRuntime()
        f.game.rng = () => {
            throw Error('reopened claim must not roll')
        }
        claim(f, 1)
        assert.deepEqual(f.state().petMutation, saved)
        assert.equal(sequence(f), 2)
    } finally {
        f.close()
        const root = path.resolve(os.tmpdir()),
            target = path.resolve(directory)
        assert(path.dirname(target) === root && path.basename(target).startsWith('lurukaps-mutation-source-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
