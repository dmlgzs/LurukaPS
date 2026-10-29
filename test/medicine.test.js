import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { medicineFixture } from './medicine-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { ReplayWindow } from '../src/replay.js'
import { encodeFrame } from '../src/wire.js'
import { registerPersonalBuffSource, removePersonalBuffSource } from '../src/medicine-state.js'
const stock = (state, itemId) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === itemId).reduce((sum, row) => sum + row.itemnum, 0)
const target = (f) => Object.values(f.state().medicine.receipts).at(-1).targets
const use = (f, itemId = 2020001, id = f.heroes[0]) => f.call('UseItem', { itemid: itemId, num: 1, args: [id] })
const sequences = (f) => f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
function unchangedReject(f, fn, code) {
    const before = f.store.load(f.session.id),
        sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        seq = sequences(f)
    assert.throws(fn, (error) => error.code === code)
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id), sql)
    assert.deepEqual(sequences(f), seq)
}

test('both real medicines produce native personal effects only after one inventory/CD acceptance, then real10721 changes HP and preserves SP', () => {
    for (const [itemId, all, cd] of [
        [2020001, false, 19],
        [2020002, true, 20],
    ]) {
        const f = medicineFixture('medicine-full-' + itemId)
        try {
            f.dead(f.heroes[0])
            if (all) f.dead(f.heroes[2])
            const before = f.state(),
                packets = use(f, itemId, all ? f.heroes[1] : f.heroes[0]),
                state = f.state(),
                updates = f.buffs(packets).flatMap((row) => row.update_buffs ?? []),
                expected = all ? [f.heroes[0], f.heroes[2]] : [f.heroes[0]]
            assert.equal(stock(state, itemId), stock(before, itemId) - 1)
            assert.deepEqual(
                updates.map((row) => row.target_id),
                expected,
            )
            assert(updates.every((row) => row.target_id !== '0' && row.buff_id === (all ? 7002 : 7001)))
            assert.deepEqual(
                f.cds(packets).flatMap((row) => row.infos),
                [{ type: cd, cd_expire: f.now() + 1800 }],
            )
            assert(packets.findIndex((row) => row.id === 11255) < packets.findIndex((row) => row.id === 9131))
            assert(packets.findIndex((row) => row.id === 9131) < packets.findIndex((row) => row.id === 6030))
            assert.deepEqual(
                f.protocol.decode(f.protocol.byId.get(6030).rsp, packets.find((row) => row.id === 6030).payload)
                    .rewards,
                [],
            )
            assert(
                expected.every((id) => state.player.heros_info.battle_infos.find((row) => row.hero_id === id).hp === 0),
            )
            for (const info of updates) {
                const revival = f.call('ReviveHero', { hero_uuid: info.target_id, revive_val: 9999999 }),
                    after = f.state()
                assert.deepEqual(
                    revival.map((row) => row.id),
                    [9131, 10009],
                )
                assert.equal(after.player.heros_info.battle_infos.find((row) => row.hero_id === info.target_id).sp, 7)
                assert(after.player.heros_info.battle_infos.find((row) => row.hero_id === info.target_id).hp > 0)
            }
            assert(
                target(f).every(
                    (row) => row.status === 'ended-by-accepted-revival' && row.origin === 'unknown-or-competing',
                ),
            )
            assert.equal(Object.values(f.state().medicine.receipts).at(-1).status, 'closed')
        } finally {
            f.store.close()
        }
    }
})

test('request shape, target eligibility, home/scene, expired stock and pending conflicts reject atomically with exact semantic codes', () => {
    const f = medicineFixture('medicine-rejections')
    try {
        unchangedReject(f, () => use(f), ErrorCode.MedicineRequireTargetDead)
        f.dead()
        unchangedReject(
            f,
            () => f.call('UseItem', { itemid: 2020001, num: 0, args: [f.heroes[0]] }),
            ErrorCode.UseItemSendNumZero,
        )
        unchangedReject(
            f,
            () => f.call('UseItem', { itemid: 2020001, num: 2, args: [f.heroes[0]] }),
            ErrorCode.UseItemArgFail,
        )
        unchangedReject(
            f,
            () => f.call('UseItem', { itemid: 2020002, num: 1, args: [] }),
            ErrorCode.MedicineRequireTarget,
        )
        unchangedReject(f, () => use(f, 2020001, '12345'), ErrorCode.MedicineRequireTarget)
        const originalMap = f.state().world.map_id,
            home = Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value)
        f.store.transact(f.session.id, 0, (state) => {
            state.world.map_id = home
        })
        unchangedReject(f, () => use(f), ErrorCode.MedicineRequireSpecMode)
        f.store.transact(f.session.id, 0, (state) => {
            state.world.map_id = originalMap
            for (const row of state.player.sbag_infos.items) if (row.itemid === 2020001) row.deadtime = f.now()
        })
        unchangedReject(f, () => use(f), ErrorCode.ItemNotEnough)
        f.store.transact(f.session.id, 0, (state) => {
            for (const row of state.player.sbag_infos.items) if (row.itemid === 2020001) delete row.deadtime
        })
        use(f)
        unchangedReject(f, () => use(f), ErrorCode.MedicineRequireCoolDown)
        unchangedReject(f, () => use(f, 2020002, f.heroes[1]), ErrorCode.TargetBusy)
        unchangedReject(
            f,
            () => f.call('BatchUseItem', { items: [{ itemid: 2020002, num: 1, args: [f.heroes[1]] }] }),
            ErrorCode.FunctionClosed,
        )
    } finally {
        f.store.close()
    }
})

test('missing revival data and malformed fields use GameConfig while valid unsupported effect families remain FunctionClosed', () => {
    const f = medicineFixture('medicine-config-categories')
    try {
        f.dead()
        const find = f.tables.find.bind(f.tables),
            common = find('common_item', 2020001),
            row = find('medicine', 2020001)
        for (const [replacement, code] of [
            [null, ErrorCode.GameConfig],
            [{ ...row, medicinType: undefined }, ErrorCode.GameConfig],
            [{ ...row, medicinType: 4 }, ErrorCode.FunctionClosed],
            [{ ...row, medicineTarget: 3 }, ErrorCode.FunctionClosed],
            [{ ...row, coolDown: -1 }, ErrorCode.GameConfig],
        ]) {
            f.tables.find = (name, id) => (name === 'medicine' && id === 2020001 ? replacement : find(name, id))
            unchangedReject(f, () => use(f), code)
        }
        f.tables.find = (name, id) =>
            id === 9999999 && name === 'common_item'
                ? { ...common, id }
                : id === 9999999 && name === 'medicine'
                  ? { ...row, id }
                  : find(name, id)
        unchangedReject(f, () => use(f, 9999999), ErrorCode.GameConfig)
        f.tables.find = find
    } finally {
        f.store.close()
    }
})

test('19/20 cooldowns are independent, exact expiry closes delivery without refund, and next acceptance gets a new lifetime and GUID', () => {
    const f = medicineFixture('medicine-cooldowns')
    try {
        f.dead(f.heroes[0])
        use(f)
        f.call('ReviveHero', { hero_uuid: f.heroes[0], revive_val: 10 })
        f.dead(f.heroes[2])
        use(f, 2020002, f.heroes[1])
        const before = f.state(),
            first = target(f)[0]
        assert.equal(before.medicine.cooldowns[19].expire, f.now() + 1800)
        assert.equal(before.medicine.cooldowns[20].expire, f.now() + 1800)
        f.time(f.now() + 1799)
        unchangedReject(f, () => use(f, 2020001, f.heroes[2]), ErrorCode.MedicineRequireCoolDown)
        f.time(f.now() + 1)
        const packets = f.game.tick(f.session.id, f.session),
            after = f.state()
        assert.deepEqual(
            f
                .cds(packets)
                .flatMap((row) => row.infos)
                .sort((a, b) => a.type - b.type),
            [
                { type: 19, cd_expire: 0 },
                { type: 20, cd_expire: 0 },
            ],
        )
        assert.equal(target(f)[0].reason, 'pending-expired')
        assert.equal(stock(after, 2020002), stock(before, 2020002))
        use(f, 2020001, f.heroes[2])
        assert(BigInt(target(f)[0].lifeToken) > BigInt(first.lifeToken))
        assert.notEqual(target(f)[0].buffGuid, first.buffGuid)
    } finally {
        f.store.close()
    }
})

test('all freezes the paid dead subset and partial observations; later formation joins do not inherit the receipt', () => {
    const f = medicineFixture('medicine-all-snapshot')
    try {
        f.dead(f.heroes[0])
        f.dead(f.heroes[2])
        use(f, 2020002, f.heroes[1])
        const receipt = Object.values(f.state().medicine.receipts)[0],
            stockBefore = stock(f.state(), 2020002)
        f.call('ReviveHero', { hero_uuid: f.heroes[0], revive_val: 10 })
        assert.equal(target(f)[0].status, 'ended-by-accepted-revival')
        assert.equal(target(f)[1].status, 'pending')
        f.call('QuickChangeGroupInfo', { type: 1, id: 1, infos: [{ hero_guid: f.heroes[1] }] })
        assert.equal(target(f)[1].status, 'cancelled')
        assert.deepEqual(
            target(f).map((row) => row.actorUuid),
            receipt.targets.map((row) => row.actorUuid),
        )
        assert.equal(stock(f.state(), 2020002), stockBefore)
        assert.equal(f.buffs(f.call('MultiCampaignPlayerLoaded')).flatMap((row) => row.update_buffs ?? []).length, 0)
    } finally {
        f.store.close()
    }
})

test('real paid pending survives no ABA: accepted10705 restore then death closes old receipt and retracking never reuses life token', () => {
    const f = medicineFixture('medicine-paid-aba')
    try {
        const id = f.heroes[0]
        f.dead()
        use(f)
        const first = target(f)[0]
        f.call('BattleInfoReduce', {
            uint64_dic: [id],
            battle_info: [
                { hurt_info: { tar_id: '1', hp_change: 100 } },
                { hurt_info: { tar_id: '1', hp_change: -100 } },
            ],
        })
        assert.equal(f.state().player.heros_info.battle_infos.find((row) => row.hero_id === id).hp, 0)
        assert.equal(target(f)[0].status, 'ended-by-external-state')
        assert.equal(f.buffs(f.call('MultiCampaignPlayerLoaded')).flatMap((row) => row.update_buffs ?? []).length, 0)
        use(f, 2020002, id)
        const second = target(f)[0]
        assert(BigInt(second.lifeToken) > BigInt(first.lifeToken))
        assert.notEqual(second.buffGuid, first.buffGuid)
        // Protocol has no origin nonce: the old non-medicine route remains compatible.
        f.call('ReviveHero', { hero_uuid: id, revive_val: 12 })
        assert.equal(target(f)[0].origin, 'unknown-or-competing')
    } finally {
        f.store.close()
    }
})

test('known external personal config precludes charge, and a later known conflict is retained without unsafe cleanup or reinjection', () => {
    const f = medicineFixture('medicine-known-conflict')
    try {
        const id = f.heroes[0]
        f.dead()
        f.store.transact(f.session.id, 0, (state) =>
            registerPersonalBuffSource(state, f.tables, { guid: 999, buff_id: 7001, target_id: id }, 'external'),
        )
        unchangedReject(f, () => use(f), ErrorCode.TargetBusy)
        f.store.transact(f.session.id, 0, (state) => removePersonalBuffSource(state, 999, 'external'))
        use(f)
        const guid = target(f)[0].buffGuid
        // Simulate an independently restored, known registered source conflict.
        f.store.transact(f.session.id, 0, (state) => {
            state.personalBuffSources = {
                ...state.personalBuffSources,
                999: { actorUuid: id, elementConfigId: 601400111, source: 'external' },
            }
        })
        const packets = f.call('MultiCampaignPlayerLoaded')
        assert.equal(target(f)[0].reason, 'known-personal-source-conflict')
        assert(!f.buffs(packets).some((row) => (row.del_buffs ?? []).includes(guid)))
        assert.equal(f.buffs(packets).flatMap((row) => row.update_buffs ?? []).length, 0)
        f.store.transact(f.session.id, 0, (state) => removePersonalBuffSource(state, 999, 'external'))
        assert(f.buffs(f.call('MultiCampaignPlayerLoaded')).some((row) => (row.del_buffs ?? []).includes(guid)))
    } finally {
        f.store.close()
    }
})

test('codec and late SQLite failure roll back paid inventory, receipts, tokens, CD, allocator and borrowed pending references', () => {
    for (const failure of ['codec', 'sql']) {
        const f = medicineFixture('medicine-rollback-' + failure)
        try {
            f.dead()
            f.call('BattleInfoReduce', { battle_info: [] })
            const pending = f.store.pending.get(f.session.id),
                before = f.store.load(f.session.id),
                seq = sequences(f),
                sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                encode = f.protocol.encode.bind(f.protocol),
                save = f.store.savePlayer
            if (failure === 'codec')
                f.protocol.encode = (name, value) => {
                    if (name.endsWith('CSWordBuffSync')) throw Error('medicine producer codec')
                    return encode(name, value)
                }
            else
                f.store.savePlayer = {
                    run() {
                        throw Error('medicine late SQL')
                    },
                }
            assert.throws(() => use(f), /medicine (producer codec|late SQL)/)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(sequences(f), seq)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sql,
            )
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            f.protocol.encode = encode
            f.store.savePlayer = save
            use(f)
            assert.equal(target(f)[0].buffGuid, 1)
        } finally {
            f.store.close()
        }
    }
})

test('real SQLite reopen and cold/hot ready replay preserve GUID, cost and expiry with early/late login deletion and bounded actual order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medicine-reopen-')),
        file = path.join(dir, 'state.sqlite')
    let f = medicineFixture('medicine-reopen', file)
    try {
        f.dead()
        use(f)
        const initial = f.state(),
            guid = target(f)[0].buffGuid,
            expire = initial.medicine.cooldowns[19].expire
        f.store.close()
        f = medicineFixture('medicine-reopen', file)
        const freshSession = {},
            entry = f.protocol.byName.get('CSProtoEnterGame'),
            hotPackets = f.game.dispatch(freshSession, {
                id: entry.id,
                seq: 77,
                payload: f.protocol.encode(entry.req, { open_id: 'medicine-reopen', reconnect: true }),
            })
        Object.assign(f.session, freshSession)
        for (const packets of [f.entryPackets, hotPackets]) {
            const indices = packets.map((row) => row.id)
            assert(indices.indexOf(9131) > indices.indexOf(5011))
            assert(indices.indexOf(9131) < indices.indexOf(5001))
            assert(indices.lastIndexOf(10009) < indices.lastIndexOf(11255))
            assert(indices.lastIndexOf(11255) < indices.lastIndexOf(9131))
        }
        assert.equal(stock(f.state(), 2020001), stock(initial, 2020001))
        for (const ready of [f.call('MultiCampaignPlayerLoaded'), f.call('MultiCampaignPlayerLoaded')]) {
            const updates = f.buffs(ready).filter((row) => (row.update_buffs ?? []).length)
            assert.deepEqual(
                updates.map((row) => row.update_buffs[0].guid),
                [guid],
            )
            assert(updates.every((row) => row.del_buffs.includes(guid)))
        }
        assert.equal(f.state().medicine.cooldowns[19].expire, expire)
        f.call('ReviveHero', { hero_uuid: f.heroes[0], revive_val: 11 })
        assert.equal(f.buffs(f.call('MultiCampaignPlayerLoaded')).flatMap((row) => row.update_buffs ?? []).length, 0)
    } finally {
        f.store.close()
        const resolvedTmp = path.resolve(os.tmpdir()),
            resolvedDir = path.resolve(dir)
        assert.equal(
            path.dirname(resolvedDir),
            resolvedTmp,
            'Medicine SQLite cleanup must remain directly inside the explicit temp directory',
        )
        assert.match(
            path.basename(resolvedDir),
            /^medicine-reopen-[A-Za-z0-9]+$/,
            'Medicine SQLite cleanup requires its generated task directory prefix',
        )
        fs.rmSync(resolvedDir, { recursive: true, force: true })
    }
})

test('same-connection ReplayWindow replays acceptance bytes; new connection has no invented medicine nonce', () => {
    const f = medicineFixture('medicine-replay')
    try {
        f.dead()
        const e = f.protocol.byName.get('CSProtoUseItem'),
            frame = {
                id: e.id,
                seq: 888,
                pushSeq: 0,
                payload: f.protocol.encode(e.req, { itemid: 2020001, num: 1, args: [f.heroes[0]] }),
            },
            window = new ReplayWindow(),
            send = (request) => {
                const cached = window.find(request)
                if (cached) return cached
                const packets = f.game.dispatch(f.session, request),
                    buffers = packets.map((packet) => encodeFrame(packet, packet.payload))
                window.save(request, buffers)
                return buffers
            },
            bytes = send(frame),
            stockAfter = stock(f.state(), 2020001)
        assert.deepEqual(send(frame), bytes)
        assert.equal(stock(f.state(), 2020001), stockAfter)
        unchangedReject(f, () => use(f), ErrorCode.MedicineRequireCoolDown)
        f.time(f.now() + 1800)
        const other = {},
            enter = f.protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(other, {
            id: enter.id,
            seq: 1,
            payload: f.protocol.encode(enter.req, { open_id: 'medicine-replay', reconnect: true }),
        })
        f.game.dispatch(other, frame)
        assert.equal(stock(f.state(), 2020001), stockAfter - 1)
        assert.equal(Object.keys(f.state().medicine.receipts).length, 2)
    } finally {
        f.store.close()
    }
})

test('actual paid over-hurt rescue and all-dead policy terminate only accepted targets; partial-all codec failure preserves the borrowed receipt', () => {
    const f = medicineFixture('medicine-paid-rescue-partial')
    try {
        const id = f.heroes[0]
        f.dead(id, 2)
        use(f)
        f.call('RescueObj', { rescue_infos: [{ from_uuid: id, tar_uuid: id, val: 10000 }] })
        assert.equal(target(f)[0].status, 'ended-by-external-state')
        assert.equal(target(f)[0].reason, 'accepted-10738-rescue')
        for (const hero of f.heroes) f.dead(hero)
        use(f, 2020002, id)
        assert.equal(target(f).length, 3)
        f.call('ReviveHero', { hero_uuid: id, revive_val: 10 })
        const pending = f.store.pending.get(f.session.id),
            receipt = pending.state.medicine.receipts['2'],
            ledger = pending.state.medicine,
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name.endsWith('SCObjBattleInfoSync')) throw Error('partial all codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('ReviveHero', { hero_uuid: f.heroes[1], revive_val: 10 }), /partial all codec/)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.strictEqual(pending.state.medicine, ledger)
        assert.strictEqual(ledger.receipts['2'], receipt)
        assert.equal(receipt.targets[0].status, 'ended-by-accepted-revival')
        assert.equal(receipt.targets[1].status, 'pending')
        f.protocol.encode = encode
        f.call('ReviveHero', { hero_uuid: f.heroes[1], revive_val: 10 })
        assert.equal(target(f)[1].status, 'ended-by-accepted-revival')
        assert.equal(receipt.targets[1].status, 'pending')
    } finally {
        f.store.close()
    }
})
