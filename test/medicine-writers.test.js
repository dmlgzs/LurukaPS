import test from 'node:test'
import assert from 'node:assert/strict'
import { medicineFixture } from './medicine-fixture.js'
import { syncBattle } from '../src/battle.js'
import { retireTrialActors } from '../src/trial-actors.js'
import { beginSceneTransition } from '../src/scene-transition.js'
import { restoreAbyssCheckpoint } from '../src/abyss-resume.js'
import { retryAbyssRoom } from '../src/abyss-flow.js'
import { abyssFixture } from './abyss-fixture.js'
import { medicineDraft, medicineContext, trackMedicineTarget } from '../src/medicine-state.js'

test('all current external recovery writers terminate a pending target at canonical apply, without inventing medicine origin', () => {
    for (const mode of ['rescue', 'world', 'transpoint', 'gm']) {
        const f = medicineFixture('medicine-writer-' + mode)
        try {
            const id = f.heroes[0]
            f.dead(id, mode === 'rescue' ? 2 : 1)
            f.seed()
            const packets =
                mode === 'rescue'
                    ? f.call('RescueObj', { rescue_infos: [{ from_uuid: id, tar_uuid: id, val: 10000 }] })
                    : mode === 'world'
                      ? f.call('WorldMapPlayerRevive')
                      : mode === 'transpoint'
                        ? f.call('WorldMapActiveBehavior', { type: 3 })
                        : f.call('GMCommand', { command: Buffer.from('heal').toString('base64') })
            const target = f.state().medicine.receipts['1'].targets[0]
            assert.equal(target.status, 'ended-by-external-state', mode)
            assert.equal(target.origin, undefined, mode)
            assert(
                f.buffs(packets).some((row) => row.del_buffs.includes(100)),
                mode,
            )
            assert.equal(f.state().medicine.cooldowns[19].expire, 1800001800)
        } finally {
            f.store.close()
        }
    }
})

test('formation membership, actual scene departure, retirement and repair close the old context; metadata resync preserves it', () => {
    for (const mode of ['formation', 'scene', 'retirement', 'repair', 'metadata']) {
        const f = medicineFixture('medicine-context-' + mode)
        try {
            const id = f.heroes[0]
            f.dead()
            f.seed()
            if (mode === 'formation')
                f.call('QuickChangeGroupInfo', { type: 1, id: 1, infos: [{ hero_guid: f.heroes[1] }] })
            else if (mode === 'metadata')
                f.call('ChangeGroupName', {
                    type: 1,
                    group_id: 1,
                    name: Buffer.from('same-members').toString('base64'),
                })
            else
                f.store.transact(f.session.id, 0, (state) => {
                    if (mode === 'scene') {
                        const old = state.world.map_id
                        state.world.map_id = 101
                        beginSceneTransition(state, old, f.now(), 256)
                        state.world.map_id = old
                        beginSceneTransition(state, 101, f.now(), 256)
                    } else if (mode === 'retirement') retireTrialActors(state, [{ guid: id }])
                    else {
                        state.player.heros_info.battle_infos.find((row) => row.hero_id === id).hp = 1
                        syncBattle({ state, tables: f.tables, push: () => {} })
                    }
                })
            const target = f.state().medicine.receipts['1'].targets[0]
            assert.equal(target.status, mode === 'metadata' ? 'pending' : 'cancelled', mode)
            assert.equal(f.state().medicine.nextLife, '1')
        } finally {
            f.store.close()
        }
    }
})

test('abyss retry and checkpoint replacement invalidate copied hero lifetime without rewinding the allocator', () => {
    const f = abyssFixture('medicine-abyss-lifetimes')
    try {
        f.call('AbyssChallenge', f.request())
        const seed = () =>
            f.store.transact(f.session.id, 0, (state) => {
                const id = state.abyssRun.heroes[0].guid,
                    row = state.player.heros_info.battle_infos.find((item) => item.hero_id === id)
                row.hp = 0
                row.alive_state = 1
                const ledger = medicineDraft(state),
                    receiptId = String(BigInt(ledger.nextReceipt) + 1n)
                ledger.nextReceipt = receiptId
                const tracked = trackMedicineTarget(state, id, row, receiptId, 0),
                    guid = Number(receiptId)
                const next = medicineDraft(state)
                next.receipts = {
                    ...next.receipts,
                    [receiptId]: {
                        id: receiptId,
                        acceptedAt: f.time.now,
                        expire: f.time.now + 1800,
                        status: 'open',
                        context: medicineContext(state),
                        targets: [
                            {
                                actorUuid: id,
                                lifeToken: tracked.lifeToken,
                                deathGeneration: 0,
                                buffGuid: guid,
                                elementConfigId: 601400111,
                                status: 'pending',
                            },
                        ],
                        costSlices: [],
                    },
                }
                next.issued = { ...next.issued, [guid]: { actorUuid: id, elementConfigId: 601400111 } }
                return receiptId
            })
        const receiptA = seed()
        f.store.transact(f.session.id, 0, (state) =>
            retryAbyssRoom({ state, tables: f.tables, now: f.time.now, push: () => {}, pushBefore: () => {} }),
        )
        assert.equal(f.state().medicine.receipts[receiptA].targets[0].status, 'cancelled')
        const receiptB = seed(),
            before = f.state(),
            run = before.abyssRun
        // Exercise the actual restore writer with an already validated snapshot
        // shape. Schema authorization itself is covered by abyss-resume tests.
        f.store.transact(f.session.id, 0, (state) =>
            restoreAbyssCheckpoint(state, state.abyssRun, {
                heroes: run.heroes,
                pets: run.pets,
                heroAttrs: run.heroAttrs,
                petAttrs: run.petAttrs,
                challenges: run.challenges,
                dead_hero_ids: [],
                completed_parts: 0,
                total_battle_time: 0,
            }),
        )
        const after = f.state()
        assert.equal(after.medicine.receipts[receiptB].targets[0].status, 'cancelled')
        assert.equal(after.medicine.nextLife, '2')
        assert.equal(after.medicine.receipts[receiptA].targets[0].lifeToken, '1')
    } finally {
        f.store.close()
    }
})
