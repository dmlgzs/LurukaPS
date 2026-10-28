import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

function remote(f) {
    f.store.transact(f.session.id, 0, (state) => {
        state.world.map_id = 101
        state.combat = undefined
    })
}
function unchangedFailure(f, run, verify) {
    const before = structuredClone(f.state())
    assert.throws(run, verify)
    assert.deepEqual(f.state(), before)
}

test('6162 remotely assigns, keeps existing products and clocks, switches roles and removes from map101', () => {
    const f = ranchFixture('ranch-remote-lifecycle')
    try {
        remote(f)
        const first = f.assign()
        assert(first.some((packet) => packet.id === 6162))
        assert(first.some((packet) => packet.id === 6102))
        assert(first.some((packet) => packet.id === 6517))
        const clock = structuredClone(f.state().home.ranches[201].product_pets[0].drop_times)
        f.elapse(180)
        f.assign()
        assert.deepEqual(f.state().home.ranches[201].product_pets[0].drop_times, clock)
        f.elapse(180)
        f.tick()
        const produced = structuredClone(f.state().home.ranches[201].drops)
        assert(produced.length > 0)
        f.store.transact(f.session.id, 0, (state) => {
            state.pets.find((pet) => pet.guid === f.pets[0]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
        })
        f.assign(f.pets[0], 0, 2)
        let ranch = f.state().home.ranches[201]
        assert.equal(ranch.harvest_pet, f.pets[0])
        assert.equal(ranch.product_pets.length, 0)
        assert.deepEqual(ranch.drops, produced)
        f.assign(f.pets[0], 2, 1)
        ranch = f.state().home.ranches[201]
        assert.equal(ranch.harvest_pet, '0')
        assert.equal(ranch.product_pets[0].slot, 2)
        assert(ranch.product_pets[0].drop_times.every((entry) => entry.time > f.now()))
        assert.deepEqual(ranch.drops, produced)
        f.call('RanchSetPetOption', { block_id: 201, slot: 2, work_type: 1, pet_guid: '0', out_hub: true })
        assert.equal(f.state().home.ranches[201].product_pets.length, 0)
        assert.deepEqual(f.state().home.ranches[201].drops, produced)
        assert.equal(f.state().pets.find((pet) => pet.guid === f.pets[0]).work_status, 0)
        assert.equal(f.state().world.map_id, 101)
    } finally {
        f.close()
    }
})

test('6162 keeps battle, block unlock, ownership and slot rules while physical ranch protocols remain home-only', () => {
    const f = ranchFixture('ranch-remote-guards')
    try {
        remote(f)
        unchangedFailure(
            f,
            () => f.assign(f.pets[0], 0, 1),
            (error) => error.code === ErrorCode.HomeRanchLvPosLimit,
        )
        unchangedFailure(
            f,
            () => f.assign('999999999'),
            (error) => error.code === ErrorCode.PetNotExist,
        )
        unchangedFailure(
            f,
            () => f.call('RanchSetPetOption', { block_id: 999, work_type: 1, slot: 1, pet_guid: f.pets[0] }),
            (error) => error.code === ErrorCode.HomeRanchNotExist,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 1
        })
        unchangedFailure(
            f,
            () => f.assign(),
            (error) => error.code === ErrorCode.HomeRanchSysLock,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 15
            const id = String(state.player.basic_info.id)
            state.combat = {
                map_id: 101,
                hatred: { players: { [id]: { id, target_obj_ids: ['999999999'], player_obj_ids: [] } }, objects: {} },
            }
        })
        unchangedFailure(
            f,
            () => f.assign(),
            (error) => error.code === ErrorCode.PlayerInFight,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.combat = undefined
        })
        for (const [name, request] of [
            ['RanchGetStoreReward', { u32: 201 }],
            ['RanchPetAutoGetReward', { block_id: 201, reward_guid: 1 }],
            ['RanchPlayerGetReward', { block_id: 201, reward_guids: [1] }],
        ])
            unchangedFailure(
                f,
                () => f.call(name, request),
                (error) => error.code === ErrorCode.PlayerNotInHome,
            )
    } finally {
        f.close()
    }
})

test('remote6162 ACK, HomeSync and SQL failure roll back pending references and saved state before a single successful retry', () => {
    const f = ranchFixture('ranch-remote-atomic')
    try {
        remote(f)
        f.store.transact(
            f.session.id,
            0,
            (state) => {
                state.ranchRemoteMarker = 'unflushed'
            },
            { defer: true },
        )
        const pending = f.store.pending.get(f.session.id),
            before = structuredClone(f.state()),
            sql = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved = sql(),
            original = f.protocol.encode.bind(f.protocol)
        for (const type of ['ProtoNullRsp', 'SCHomeSync']) {
            f.protocol.encode = (name, value) => {
                if (name.split('.').at(-1) === type) throw Error(`injected ${type}`)
                return original(name, value)
            }
            assert.throws(() => f.assign(), new RegExp(`injected ${type}`))
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(sql(), saved)
        }
        f.protocol.encode = original
        f.store.db.exec(
            "CREATE TRIGGER reject_ranch_remote BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'injected ranch SQL'); END",
        )
        assert.throws(() => f.assign(), /injected ranch SQL/)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(sql(), saved)
        f.store.db.exec('DROP TRIGGER reject_ranch_remote')
        f.assign()
        assert.equal(f.state().home.ranches[201].product_pets.length, 1)
        assert.equal(f.state().ranchRemoteMarker, 'unflushed')
        assert.equal(f.store.pending.has(f.session.id), false)
        const clock = structuredClone(f.state().home.ranches[201].product_pets[0].drop_times)
        f.assign()
        assert.deepEqual(f.state().home.ranches[201].product_pets[0].drop_times, clock)
    } finally {
        f.close()
    }
})

test('6162 enforces both current system171 clauses and rejects damaged or unsupported future gates without mutation', () => {
    const f = ranchFixture('ranch-remote-system171')
    try {
        remote(f)
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 14
        })
        unchangedFailure(
            f,
            () => f.assign(),
            (error) => error.code === ErrorCode.SystemLock,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 15
            state.taskRecords = state.taskRecords.filter((row) => row.task_id !== 106010)
            state.tasks = state.tasks.filter((row) => row.task_id !== 106010)
        })
        unchangedFailure(
            f,
            () => f.assign(),
            (error) => error.code === ErrorCode.SystemLock,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 14
        })
        unchangedFailure(
            f,
            () => f.assign(),
            (error) => error.code === ErrorCode.SystemLock,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.lv = 15
            state.tasks.push({ task_id: 106010, finish_nodes: [195], nodes: [] })
        })
        const find = f.tables.find.bind(f.tables),
            original = find('system_unlock', 171)
        try {
            for (const [row, code] of [
                [undefined, ErrorCode.GameConfig],
                [{ ...original, unlockCondi: null }, ErrorCode.GameConfig],
                [{ ...original, unlockCondi: '(12045#106010#195)&&(2004#bad)' }, ErrorCode.GameConfig],
                [{ ...original, unlockCondi: '(12045#106010#195)||(2004#15)' }, ErrorCode.FunctionClosed],
                [{ ...original, unlockCondi: '(999999#1)' }, ErrorCode.FunctionClosed],
            ]) {
                f.tables.find = (name, id) => (name === 'system_unlock' && id === 171 ? row : find(name, id))
                unchangedFailure(
                    f,
                    () => f.assign(),
                    (error) => error.code === code,
                )
            }
        } finally {
            f.tables.find = find
        }
        f.assign()
        assert.equal(f.state().home.ranches[201].product_pets.length, 1)
    } finally {
        f.close()
    }
})
