import test from 'node:test'
import assert from 'node:assert/strict'
import current from '../configs/battle-config/teaching-current-proof-ir.json' with { type: 'json' }
import historical from '../configs/battle-config/teaching-kill-conditions.json' with { type: 'json' }
import { currentTeachingProofCapability } from '../src/teaching-kill-conditions.js'
import { teachingProfileFixture, teachingProfileAssets } from './teaching-current-profiles-fixture.js'

const skill = (id, index = 0, extra = {}) => ({ kind: 'skill', id, index, ...extra })
const wait = (milliseconds) => ({ kind: 'wait', milliseconds })
const element = (id, extra = {}) => ({ kind: 'element', id, ...extra })

// Vectors are explicit current root-flow observations, not derived from the
// runtime ops under test. Current raw graph UTF8 hashes pin the new source.
const profiles = [
    {
        fsm: 1010071,
        train: 304,
        hero: 101007,
        scenes: [6257, 6258],
        source: '1e63917f1ab0aedc5d95e54ad39594526ed02f51bd377a2a2ef0d9681e243854',
        steps: [skill(10100704), skill(10100705), skill(10100712, 1), wait(2000)],
    },
    {
        fsm: 1010101,
        train: 308,
        hero: 101010,
        scenes: [6265, 6266],
        source: 'baed990c614f6afd8a87c5b08c320a749aed3ddb519b61561d34e97ab12d8ae5',
        steps: [
            skill(10101013, 0, { producerOnly: true }),
            element(101010129),
            skill(10101005, 1),
            skill(10101005, 1),
            wait(2000),
            skill(10101042, 0, { anyOf: true }),
            skill(10101042, 1, { anyOf: true }),
            skill(10101042, 0, { anyOf: true }),
            wait(2000),
        ],
    },
    {
        fsm: 1010141,
        train: 324,
        hero: 101014,
        scenes: [6297, 6298],
        source: 'd645979ba5f99e7bf4ca5838c6c244b0f2b77f3e7f888b9307d2bc4d2fc34eb3',
        steps: [
            skill(10101412),
            wait(1000),
            skill(10101404),
            wait(1500),
            skill(10101412),
            wait(1500),
            skill(10101413),
            wait(6000),
        ],
    },
    {
        fsm: 1020011,
        train: 303,
        hero: 102001,
        scenes: [6255, 6256],
        source: 'd0a7190f0e93232a357bc5c41f20a02e0c096900e917ba8acb1d70c98b2ad9d6',
        steps: [skill(10200112), element(102001423, { clientModel: 'trigger110-before-damage' }), wait(1000)],
    },
    {
        fsm: 1070021,
        train: 302,
        hero: 107002,
        scenes: [6253, 6254],
        source: '416049775c607b482401318ba19637b1d459873f03088633bef7ba5ed4a4364a',
        steps: [skill(10700204), skill(10700212), wait(3000), skill(10700213), skill(10700210), wait(3000)],
    },
    {
        fsm: 1070031,
        train: 301,
        hero: 107003,
        scenes: [6251, 6252],
        source: '2f22cb516475a54ff3841239f8e4485defaf2e1e35df7ce79c4d8e5746c780b2',
        steps: [
            skill(10700310, 0, { castGroup: 'combo' }),
            skill(10700310, 1, { castGroup: 'combo' }),
            skill(10700310, 2, { castGroup: 'combo' }),
            wait(3000),
        ],
    },
    {
        fsm: 1080051,
        train: 310,
        hero: 108005,
        scenes: [6269, 6270],
        source: '1e13294567d3815807655ecdbacc2a399135c97b605096213400c972a27253d6',
        steps: [skill(10800513), wait(2000), skill(10800510, 2), skill(10800510, 2), wait(2000)],
    },
    {
        fsm: 1120021,
        train: 316,
        hero: 112002,
        scenes: [6281, 6282],
        source: '5b757a55295f7a2546102d99c8bebcf0f41ef679027d7b7708d81eef33f51a0c',
        steps: [
            skill(11200210, 1, { producerOnly: true }),
            element(112002118),
            wait(1000),
            skill(11200212),
            wait(2000),
            skill(11200213),
            wait(3000),
        ],
    },
]

function rejectEarlyKill(f) {
    const before = f.state()
    assert.throws(() => f.call('StoryKill', { guid: f.targets().map((row) => row.uid) }))
    assert.deepEqual(f.state(), before, 'incomplete or early proof is an atomic rejection')
}

function local110Premises(f) {
    return {
        passive61LocallyInitialized: true,
        trigger110Installed: true,
        eventType: 3,
        damageType: 1,
        ignoreDamageEvent: false,
        selfGuid: f.actor().guid,
        sourceGuid: f.actor().guid,
        targetGuid: f.targets()[0].uid,
        localHeroElementIds: [102001141],
    }
}

function complete(f, profile) {
    const enemies = f.targets(),
        ids = enemies.map((row) => row.uid)
    const packets = f.call('StoryKill', { guid: ids })
    const ack = f.protocol.byName.get('CSProtoStoryKill').id
    assert(packets.findIndex((p) => p.id === 10009) >= 0)
    const acknowledgement = packets.find((packet) => packet.id === ack)
    assert(acknowledgement)
    assert.deepEqual(f.protocol.decode('cs.ProtoNullRsp', acknowledgement.payload), {})
    // Current StoryKillReq06012ba9 sends10799 with a null callback (IL0094),
    // then EndAction immediately. Its empty ACK is not an HP-cache barrier.
    for (const id of ids) {
        const s = f.state()
        assert.equal(s.combat.entities[id].hp, 0)
        assert.equal(s.combat.enemyTerminals[id].hp, 0)
        assert.equal(s.storyKillReceipts[profile.scenes[0] + ':' + id].source, profile.source)
    }
    f.call('EndDungeonScene', { result: 3 })
    assert.equal(f.state().storyCampaign.status, 2)
    assert(!f.state().teachingRecords?.includes(profile.train))
    assert.deepEqual(teachingProfileAssets(f.state()), f.initialAssets)
    f.nextScene(profile.scenes[1])
    assert.equal(f.state().world.map_id, profile.scenes[1])
    assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
    f.killOrdinaryScene()
    f.call('EndDungeonScene', { result: 3 })
    assert.equal(f.state().storyCampaign.status, 3)
    assert.equal(f.state().teachingRecords.filter((id) => id === profile.train).length, 1)
    assert.equal(f.tables.get('train_task').find((row) => row.taskid === profile.train).passReward, '')
    assert.deepEqual(
        teachingProfileAssets(f.state()),
        f.initialAssets,
        'do not invent an award absent from current train_task',
    )
    const earned = f.state()
    f.call('EndDungeonScene', { result: 3 })
    assert.deepEqual(teachingProfileAssets(f.state()), teachingProfileAssets(earned))
    if ([1010101, 1020011, 1120021].includes(profile.fsm)) {
        f.reconnect()
        assert.equal(f.state().teachingRecords.filter((id) => id === profile.train).length, 1)
        assert.deepEqual(teachingProfileAssets(f.state()), f.initialAssets)
    }
    f.call('CampaignQuit')
    assert(!f.state().storyCampaign)
    assert(!f.state().trialGroup)
    assert.deepEqual(teachingProfileAssets(f.state()), f.initialAssets)
    assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
}

for (const profile of profiles)
    test(
        'current profile' + profile.fsm + ' completes actual TeachStart, current observations,10799 and both scenes',
        () => {
            const rule = current.profiles.find((row) => row.battleFsmType === profile.fsm)
            assert(rule, 'current candidate must be installed; an old rule is not current support')
            assert.equal(rule.sourceSha256, profile.source)
            assert.notEqual(
                rule.sourceSha256,
                historical.rules.find((row) => row.battleFsmType === profile.fsm).sourceSha256,
            )
            assert.deepEqual(currentTeachingProofCapability(profile.fsm), { available: true, source: profile.source })
            for (const op of rule.ops.filter((op) => op.kind === 'element')) {
                assert.deepEqual(op.networkOperations, [1])
                assert.equal(op.elementContract?.shape, 'current-lasting-initial-local-add-v1')
                assert.equal(op.elementContract.runtimeIsLasting, true)
                assert.equal(op.elementContract.serializedIsLasting, false)
                assert.equal(
                    op.elementContract.sourceHashes.mmap,
                    'c590dbb2720eb45d23d900734bcb4968f5139aeff41eb51e3c9b9832c0dafe87',
                )
            }
            const f = teachingProfileFixture(profile)
            try {
                rejectEarlyKill(f)
                assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
                f.call('SkillStart', {
                    unit_id: f.actor().guid,
                    skill: { skill_id: 99999999, index: 0, begin_time: String(f.nowMs()) },
                    op_time: String(f.nowMs()),
                })
                assert.equal(f.proof(), undefined, 'an unrelated skill cannot provide current proof')
                if (profile.fsm === 1020011)
                    assert.equal(
                        f.localImmune423Frame(local110Premises(f)),
                        null,
                        'passive initialization alone is not the active skill12 trigger',
                    )
                const casts = new Map()
                let first = true
                for (const step of profile.steps) {
                    if (step.kind === 'wait') {
                        f.advance(step.milliseconds - 1)
                        rejectEarlyKill(f)
                        f.advance(1)
                        continue
                    }
                    f.advance(1)
                    const previous = f.proof()
                    const position = previous && [previous.op, previous.count]
                    let packet
                    if (step.kind === 'skill') {
                        if (step.castGroup && !casts.has(step.castGroup)) casts.set(step.castGroup, f.nowMs())
                        packet = f.skillFrame(
                            step.id,
                            step.index,
                            step.castGroup ? casts.get(step.castGroup) : f.nowMs(),
                        )
                    } else {
                        const beforeElement = structuredClone(f.proof())
                        for (const operation of [7, 10]) {
                            const uid = 980000 + operation
                            f.dispatch(f.elementFrame({ ...step, operation, uid }))
                            assert.deepEqual(
                                f.proof(),
                                beforeElement,
                                'combine/remote operations do not supply a fresh local trigger',
                            )
                            f.dispatch(f.elementFrame({ ...step, operation: 1, uid }))
                            assert.deepEqual(
                                f.proof(),
                                beforeElement,
                                'a previously seen UID is not a fresh local injection',
                            )
                        }
                        f.dispatch(f.elementFrame({ ...step, executor: 'enemy' }))
                        assert.deepEqual(
                            f.proof(),
                            beforeElement,
                            'Monster executor cannot stand in for the actual Hero producer',
                        )
                        if (step.clientModel) {
                            const local = local110Premises(f)
                            // Explicit model premises, not a claim that casting12
                            // created141 or that server physics ran BeforeReceiveDamage.
                            for (const invalid of [
                                { ...local, passive61LocallyInitialized: false },
                                { ...local, trigger110Installed: false },
                                { ...local, eventType: 2 },
                                { ...local, damageType: 5 },
                                { ...local, damageType: 11 },
                                { ...local, ignoreDamageEvent: true },
                                { ...local, selfGuid: local.targetGuid },
                                { ...local, sourceGuid: local.targetGuid },
                                { ...local, localHeroElementIds: [] },
                            ])
                                assert.equal(f.localImmune423Frame(invalid), null)
                            assert.deepEqual(f.proof(), beforeElement)
                            rejectEarlyKill(f)
                            packet = f.localImmune423Frame(local)
                            assert(packet, 'the bounded client model must produce an actual op1 report')
                        } else packet = f.elementFrame(step)
                    }
                    f.dispatch(packet)
                    if (step.producerOnly) {
                        assert.deepEqual(
                            f.proof(),
                            previous,
                            'the producer cast itself does not replace its emitted element',
                        )
                        continue
                    }
                    const p = f.proof()
                    assert(p, 'current producer did not establish proof for ' + JSON.stringify(step))
                    assert.equal(p.version, 3)
                    assert.equal(p.source, profile.source)
                    assert.notDeepEqual(
                        [p.op, p.count],
                        position,
                        'the ordered current observation must advance its expected stage',
                    )
                    const accepted = structuredClone(p)
                    f.dispatch(packet)
                    assert.deepEqual(f.proof(), accepted, 'same actual observation cannot count twice')
                    if (profile.fsm === 1020011 && step.kind === 'skill') {
                        for (const index of [1, 2, 1, 2]) {
                            f.advance(1)
                            f.dispatch(f.skillFrame(10200149, index))
                        }
                        assert.deepEqual(
                            f.proof(),
                            accepted,
                            'the old disconnected skill49 pair loop cannot stand in for current element423',
                        )
                        rejectEarlyKill(f)
                    }
                    if (step.anyOf) {
                        const changedIndex = f.skillFrame(step.id, step.index === 0 ? 1 : 0)
                        f.dispatch(changedIndex)
                        assert.deepEqual(
                            f.proof(),
                            accepted,
                            'another child on the same cast cannot cross a loop boundary',
                        )
                    }
                    if (first && [1010101, 1020011, 1120021].includes(profile.fsm)) {
                        f.reconnect()
                        f.dispatch(packet)
                        assert.deepEqual(
                            f.proof(),
                            accepted,
                            'relogin retains same-run deduplication and current source',
                        )
                    }
                    first = false
                }
                complete(f, profile)
            } finally {
                f.store.close()
            }
        },
    )
