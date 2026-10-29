import test from 'node:test'
import assert from 'node:assert/strict'
import { medicineFixture } from './medicine-fixture.js'
import {
    observeAcceptedHeroVitals,
    trackMedicineTarget,
    medicineDraft,
    invalidateTrackedHeroes,
    registerPersonalBuffSource,
    personalBuffFrames,
    validateMedicineLedger,
} from '../src/medicine-state.js'
import { ErrorCode } from '../src/error-codes.js'
import { abyssFixture } from './abyss-fixture.js'
import { medicineContext } from '../src/medicine-state.js'

test('untracked health writers allocate nothing; tracked small COW branches preserve borrowed closed history and fresh lifetime high water', () => {
    const state = {}
    observeAcceptedHeroVitals(state, '1', { hp: 0, alive_state: 1 }, 'untracked')
    assert.deepEqual(state, {})
    const base = {
        medicine: {
            version: 1,
            nextLife: '5',
            nextReceipt: '1',
            tracked: {},
            receipts: {
                1: {
                    status: 'open',
                    expire: 1800001800,
                    context: 'unit-only',
                    targets: [{ actorUuid: '1', lifeToken: '6', deathGeneration: 0, status: 'pending' }],
                },
            },
            cooldowns: {},
            issued: {},
            cleanup: {},
        },
    }
    const draft = { ...base },
        tracked = trackMedicineTarget(draft, '1', { hp: 0, alive_state: 1 }, '1', 0)
    observeAcceptedHeroVitals(draft, '1', { hp: 0, alive_state: 2 }, 'row')
    assert.equal(draft.medicine.tracked['1'].deathGeneration, 0)
    assert.equal(draft.medicine.tracked['1'].hp, 0)
    assert.equal(tracked.lifeToken, '6')
    assert.equal(base.medicine.nextLife, '5')
    assert.deepEqual(base.medicine.tracked, {})
    assert.strictEqual(base.medicine.receipts, draft.medicine.receipts)
    assert.strictEqual(base.medicine.issued, draft.medicine.issued)
    assert.strictEqual(base.medicine.cleanup, draft.medicine.cleanup)
})

test('corrupt managed envelope, receipt, issued GUID and current row fail with GameConfig at actual tick, normal, fast and ready boundaries', () => {
    const f = medicineFixture('medicine-corrupt-ledger')
    try {
        f.dead()
        f.seed()
        const good = f.state().medicine,
            id = f.heroes[0]
        const corruptions = [
            (state) => {
                state.medicine = null
            },
            (state) => {
                state.medicine.cleanup = null
            },
            (state) => {
                delete state.medicine.cleanup
            },
            (state) => {
                state.medicine.issued['4294967296'] = { actorUuid: id, elementConfigId: 601400111 }
            },
            (state) => {
                state.medicine.cleanup[100] = null
            },
            (state) => {
                state.medicine.receipts['1'] = null
            },
            (state) => {
                state.medicine.receipts['1'].targets[0] = null
            },
            (state) => {
                delete state.medicine.receipts['1'].worldBuffId
            },
            (state) => {
                state.medicine.receipts['1'].itemId = 999999
            },
            (state) => {
                state.medicine.receipts['1'].cooldownType = 20
            },
            (state) => {
                state.medicine.tracked[id].hp = -1
            },
            (state) => {
                state.medicine.tracked[id].aliveState = 9
            },
            (state) => {
                state.medicine.tracked[id].dead = false
            },
            (state) => {
                delete state.medicine.tracked[id].vitalsRevision
            },
        ]
        for (const corrupt of corruptions) {
            const state = f.state()
            corrupt(state)
            assert.throws(() => validateMedicineLedger(state), { code: ErrorCode.GameConfig })
        }
        for (const [action, mutate] of [
            [
                () => f.game.tick(f.session.id, f.session),
                (state) => {
                    state.medicine.cooldowns = null
                },
            ],
            [
                () =>
                    f.call('ChangeGroupName', {
                        type: 1,
                        group_id: 1,
                        name: Buffer.from('invalid').toString('base64'),
                    }),
                (state) => {
                    state.medicine.cleanup = 0
                },
            ],
            [
                () => f.call('ReviveHero', { hero_uuid: id, revive_val: 10 }),
                (state) => {
                    delete state.medicine.cleanup
                },
            ],
            [
                () => f.call('ReviveHero', { hero_uuid: id, revive_val: 10 }),
                (state) => {
                    state.medicine.tracked[id] = null
                },
            ],
            [
                () => f.call('MultiCampaignPlayerLoaded'),
                (state) => {
                    state.medicine.receipts['1'] = null
                },
            ],
        ]) {
            f.store.transact(f.session.id, 0, (state) => {
                state.medicine = structuredClone(good)
                mutate(state)
            })
            const before = f.store.load(f.session.id)
            assert.throws(action, { code: ErrorCode.GameConfig })
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.store.close()
    }
})

test('reconnect deletes closed own GUID despite a new same-config pending, then del/update the active GUID in one frame', () => {
    const f = medicineFixture('medicine-old-guid-new-pending')
    try {
        const id = f.heroes[0]
        f.dead()
        f.seed()
        f.call('ReviveHero', { hero_uuid: id, revive_val: 10 }) // client may lose this cleanup
        f.dead()
        f.store.transact(f.session.id, 0, (state) => {
            const old = state.medicine.receipts['1'],
                ledger = medicineDraft(state)
            ledger.nextReceipt = '2'
            const row = state.player.heros_info.battle_infos.find((row) => row.hero_id === id),
                tracked = trackMedicineTarget(state, id, row, '2', 0),
                next = medicineDraft(state),
                target = {
                    actorUuid: id,
                    lifeToken: tracked.lifeToken,
                    deathGeneration: 0,
                    buffGuid: 101,
                    elementConfigId: 601400111,
                    status: 'pending',
                }
            next.receipts = { ...next.receipts, 2: { ...old, id: '2', status: 'open', targets: [target] } }
            next.cooldowns = { ...next.cooldowns, 19: { expire: old.expire, receipt: '2' } }
            next.issued = { ...next.issued, 101: { actorUuid: id, elementConfigId: 601400111 } }
            registerPersonalBuffSource(state, f.tables, { guid: 101, buff_id: 7001, target_id: id }, 'medicine')
        })
        const frames = f.buffs(f.call('MultiCampaignPlayerLoaded')),
            update = frames.findIndex((row) => (row.update_buffs ?? []).some((row) => row.guid === 101)),
            oldDelete = frames.findIndex((row) => (row.del_buffs ?? []).includes(100))
        assert(oldDelete >= 0 && oldDelete < update)
        assert(frames[update].del_buffs.includes(101))
        assert.equal(f.state().medicine.receipts['1'].targets[0].status, 'ended-by-accepted-revival')
    } finally {
        f.store.close()
    }
})

test('active abyss defers personal re-delivery from9596 to its validated9509 domain, preserving native empty9596 behavior', () => {
    const f = abyssFixture('medicine-ready-domain')
    try {
        f.call('AbyssChallenge', f.request())
        f.store.transact(f.session.id, 0, (state) => {
            const id = state.abyssRun.heroes[0].guid,
                row = state.player.heros_info.battle_infos.find((row) => row.hero_id === id)
            row.hp = 0
            row.alive_state = 1
            const ledger = medicineDraft(state)
            ledger.nextReceipt = '1'
            const tracked = trackMedicineTarget(state, id, row, '1', 0),
                next = medicineDraft(state),
                target = {
                    actorUuid: id,
                    lifeToken: tracked.lifeToken,
                    deathGeneration: 0,
                    buffGuid: 100,
                    elementConfigId: 601400111,
                    status: 'pending',
                }
            next.receipts = {
                1: {
                    id: '1',
                    itemId: 2020001,
                    quantity: 1,
                    cooldownType: 19,
                    worldBuffId: 7001,
                    acceptedAt: f.time.now,
                    expire: f.time.now + 1800,
                    context: medicineContext(state),
                    status: 'open',
                    costSlices: [{ guid: '1', itemId: 2020001, quantity: 1, deadtime: 0 }],
                    targets: [target],
                },
            }
            next.cooldowns = { 19: { expire: f.time.now + 1800, receipt: '1' } }
            next.issued = { 100: { actorUuid: id, elementConfigId: 601400111 } }
            registerPersonalBuffSource(state, f.tables, { guid: 100, buff_id: 7001, target_id: id }, 'medicine')
        })
        const ordinary = f.call('MultiCampaignPlayerLoaded')
        assert.equal(ordinary.filter((row) => row.id === 9131).length, 0)
        const domain = f.call('StartDungeonClientOk'),
            buffs = domain.filter((row) => row.id === 9131).map((row) => f.p.decode('CSWordBuffSync', row.payload))
        assert.equal(buffs.length, 1)
        assert.deepEqual(buffs[0].del_buffs, [100])
        assert.equal(buffs[0].update_buffs[0].guid, 100)
        assert.equal(f.state().medicine.cooldowns[19].expire, f.time.now + 1800)
    } finally {
        f.store.close()
    }
})

test('10705 accepted row ABA closes old paid target before final HP projection; failed codec preserves pending references', () => {
    const f = medicineFixture('medicine-foundation-aba')
    try {
        const id = f.heroes[0]
        f.dead(id)
        f.seed()
        const base = f.store.load(f.session.id).state
        // A pending deferred record exercises the actual shallow report fork.
        f.store.pending.set(f.session.id, { state: base, revision: 0 })
        const oldMedicine = base.medicine,
            oldReceipt = base.medicine.receipts['1'],
            oldTracked = base.medicine.tracked[id]
        const packet = {
            uint64_dic: [id],
            battle_info: [
                { hurt_info: { tar_id: '1', hp_change: 100 } },
                { hurt_info: { tar_id: '1', hp_change: -100 } },
            ],
        }
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name.endsWith('SCObjBattleInfoSync')) throw Error('medicine ABA codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('BattleInfoReduce', packet), /medicine ABA codec/)
        assert.strictEqual(f.store.pending.get(f.session.id).state.medicine, oldMedicine)
        assert.strictEqual(oldMedicine.receipts['1'], oldReceipt)
        assert.strictEqual(oldMedicine.tracked[id], oldTracked)
        assert.equal(oldTracked.hp, 0)
        f.protocol.encode = encode
        const packets = f.call('BattleInfoReduce', packet),
            after = f.state()
        assert.equal(after.player.heros_info.battle_infos.find((row) => row.hero_id === id).hp, 0)
        assert.equal(after.medicine.receipts['1'].targets[0].status, 'ended-by-external-state')
        assert.equal(after.medicine.receipts['1'].targets[0].reason, 'accepted-10705-row')
        assert.equal(after.medicine.tracked[id], undefined)
        assert.equal(oldReceipt.targets[0].status, 'pending')
        assert(packets.findIndex((packet) => packet.id === 9131) < packets.findIndex((packet) => packet.id === 10009))
        const retracked = { ...after },
            token = trackMedicineTarget(retracked, id, { hp: 0, alive_state: 1 }, 'test-only', 0).lifeToken
        assert(BigInt(token) > BigInt(oldTracked.lifeToken))
    } finally {
        f.store.close()
    }
})

test('10721 prepare/apply emits own cleanup before HP and records unknown competing origin; invalid HP cannot consume target', () => {
    const f = medicineFixture('medicine-foundation-revive')
    try {
        const id = f.heroes[0]
        f.dead(id)
        f.seed()
        const before = f.state().medicine
        assert.throws(() => f.call('ReviveHero', { hero_uuid: id, revive_val: 0 }))
        assert.deepEqual(f.state().medicine, before)
        const packets = f.call('ReviveHero', { hero_uuid: id, revive_val: 25 }),
            state = f.state()
        assert.deepEqual(
            packets.map((packet) => packet.id),
            [9131, 10009],
        )
        const target = state.medicine.receipts['1'].targets[0]
        assert.equal(target.status, 'ended-by-accepted-revival')
        assert.equal(target.origin, 'unknown-or-competing')
        assert.equal(state.player.heros_info.battle_infos.find((row) => row.hero_id === id).sp, 7)
        assert.deepEqual(
            f.call('ReviveHero', { hero_uuid: id, revive_val: 99 }).map((packet) => packet.id),
            [10009],
        )
    } finally {
        f.store.close()
    }
})

test('known managed source guard, version validation and bounded cleanup frames enforce shared configuration contract', () => {
    const f = medicineFixture('medicine-foundation-registry')
    try {
        const id = f.heroes[0]
        f.dead(id)
        f.seed()
        const state = f.state(),
            before = structuredClone(state)
        assert.throws(
            () => registerPersonalBuffSource(state, f.tables, { guid: 999, buff_id: 7002, target_id: id }, 'external'),
            { code: ErrorCode.TargetBusy },
        )
        assert.deepEqual(state, before)
        state.medicine = { ...state.medicine, version: 99 }
        assert.throws(() => validateMedicineLedger(state), { code: ErrorCode.GameConfig })
        const frames = personalBuffFrames({ del_buffs: Array.from({ length: 1000 }, (_, index) => index + 1) })
        assert(frames.every((frame) => frame.del_buffs.length <= 128))
        assert.equal(frames.flatMap((frame) => frame.del_buffs).length, 1000)
    } finally {
        f.store.close()
    }
})

test('9596 repeats same personal GUID after CD and deletes without spending or extending; context retirement suppresses delivery', () => {
    const f = medicineFixture('medicine-foundation-ready')
    try {
        f.dead()
        f.seed()
        const before = f.state(),
            a = f.call('MultiCampaignPlayerLoaded'),
            b = f.call('MultiCampaignPlayerLoaded')
        for (const packets of [a, b]) {
            const frames = f.buffs(packets)
            assert.deepEqual(
                frames.flatMap((row) => row.del_buffs ?? []),
                [100],
            )
            assert.deepEqual(
                frames.flatMap((row) => row.update_buffs ?? []).map((row) => row.guid),
                [100],
            )
            assert(packets.findIndex((row) => row.id === 11255) < packets.findIndex((row) => row.id === 9131))
        }
        assert.equal(f.state().medicine.receipts['1'].expire, before.medicine.receipts['1'].expire)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        f.store.transact(f.session.id, 0, (state) => invalidateTrackedHeroes(state, [f.heroes[0]], 'test-retirement'))
        const packets = f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.buffs(packets).flatMap((row) => row.update_buffs ?? []).length, 0)
    } finally {
        f.store.close()
    }
})
