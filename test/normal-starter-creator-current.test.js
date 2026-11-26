import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-creator-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [
    { createNormalStarterFixture },
    { normalCreatorDriver, applyCurrentHeroPackets },
    { mainHeroConfigId },
    { TaskGraphs },
    { taskActions },
] = await Promise.all([
    import('./normal-starter-current-fixture.js'),
    import('./normal-starter-creator-driver.js'),
    import('../src/main-hero.js'),
    import('../src/tasks.js'),
    import('../src/task-scenes.js'),
])
console.log('[normal-creator-current-artifacts] ' + artifacts)

for (const sex of [1, 2])
    test(
        'normal genuine106001 node11 pending then5010 sex' +
            sex +
            ' retains one cached persona and grants the first card once',
        () => {
            const name = 'normal-creator-sex' + sex
            const f = createNormalStarterFixture(name, {
                starterProfile: 'normal',
                traceDirectory: path.join(artifacts, 'trace'),
            })
            const clientHeroes = new Map()
            const clientAttributes = new Map()
            const consume = (packets) => {
                applyCurrentHeroPackets(f.protocol, clientHeroes, packets)
                for (const packet of packets) {
                    if (packet.id === 5001) clientAttributes.clear()
                    const descriptor = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
                    if (packet.id === descriptor.id)
                        for (const row of f.protocol.decode(descriptor.rsp, packet.payload).heros)
                            clientAttributes.set(row.hero_guid, row)
                }
            }
            const driver = normalCreatorDriver(f, consume)
            let pending
            let attributeEvidence
            const cards = () =>
                f
                    .state()
                    .player.sbag_infos.items.filter((item) => item.itemid === 1000001)
                    .reduce((sum, item) => sum + item.itemnum, 0)
            try {
                pending = driver.reachPendingCreator()
                assert.equal(clientHeroes.size, 1)
                const guid = pending.persona.guid,
                    expected = mainHeroConfigId(f.tables, sex)
                assert.equal(f.state().normalStarterAvatar.phase, 'provisional')
                const cachedBefore = clientAttributes.get(guid)
                assert(
                    cachedBefore &&
                        cachedBefore.hero_conf_id === pending.persona.conf_id &&
                        cachedBefore.modules.length > 0,
                )
                const request = f.frame('PlayerCustomData', {
                    name: Buffer.from('NormalSex' + sex).toString('base64'),
                    wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex },
                })
                const packets = f.dispatch(request)
                consume(packets)
                const owned = f.state().player.heros_info.heros
                assert.equal(owned.length, 1)
                assert.equal(
                    owned[0].guid,
                    guid,
                    'nontrial persona identity is stable; never delete female and append a ghost male',
                )
                assert.equal(owned[0].conf_id, expected)
                assert.equal(owned[0].type, 1)
                assert.equal(clientHeroes.size, 1)
                assert.equal(clientHeroes.get(guid).conf_id, expected)
                assert.equal(f.state().player.basic_info.sex, sex)
                assert.equal(f.state().characterCustomized, true)
                assert.equal(f.state().pendingCharacterTask, undefined)
                assert.equal(cards(), 1, 'current task_step1004/drop16001 is the first real ordinary-card reward')
                const ack = packets.findIndex((packet) => packet.id === request.id)
                const attrs = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
                const attrIndex = packets.findIndex(
                    (packet) =>
                        packet.id === attrs.id &&
                        f.protocol
                            .decode(attrs.rsp, packet.payload)
                            .heros.some((hero) => hero.hero_guid === guid && hero.hero_conf_id === expected),
                )
                if (expected !== pending.persona.conf_id) assert(attrIndex >= 0 && attrIndex < ack)
                else
                    assert.equal(
                        cachedBefore.hero_conf_id,
                        expected,
                        'same-conf selection may suppress identical10006 only when the sent cache is already correct',
                    )
                if (attrIndex >= 0) assert(attrIndex < ack)
                assert.equal(clientAttributes.get(guid).hero_conf_id, expected)
                attributeEvidence = {
                    priorConfig: cachedBefore.hero_conf_id,
                    selectedConfig: expected,
                    currentPacketIndex: attrIndex,
                    ackIndex: ack,
                    sameConfigSuppressed: expected === pending.persona.conf_id && attrIndex < 0,
                }
                const afterStories = taskActions(new TaskGraphs(f.tables).get(106001).nodes.get(11), 'after')
                    .map((action) => action.__type_TaskOpenStoryData)
                    .filter(Boolean)
                if (afterStories.some((story) => story.isPlayEndCb === true || story.isPlayEndCb === 1))
                    assert(f.state().pendingTaskStorySync)
                else
                    assert.equal(
                        f.state().pendingTaskStorySync,
                        undefined,
                        'end-callback actions do not invent a begin-callback story barrier',
                    )
                driver.finishCreatorActions()
                assert.equal(f.state().pendingTaskStorySync, undefined)
                for (const story of afterStories)
                    assert(
                        Object.values(f.state().storyWatches ?? {}).some(
                            (watch) =>
                                watch.story_id === story.storyId &&
                                watch.story_type === f.tables.find('story', story.storyId).storyType &&
                                watch.tag === 0 &&
                                watch.full_watch === true,
                        ),
                        'real6060 full-watch receipt for configured creator after-story',
                    )
                assert(
                    f
                        .state()
                        .tasks.find((task) => task.task_id === 106001)
                        .nodes.some((node) => node.node_id === 63),
                )
                assert.equal(f.currentGroup().control, guid)
                assert.deepEqual(f.state().pets, [])
                assert.deepEqual(f.state().recordPets ?? [], [])
                f.dispatch(request)
                driver.call('MultiTaskClientAfter', { task_params: [{ task_id: 106001, node_id: 11 }] })
                assert.equal(cards(), 1)
                consume(f.login())
                assert.equal(f.state().player.heros_info.heros.length, 1)
                assert.equal(f.state().player.heros_info.heros[0].guid, guid)
                assert.equal(f.state().player.heros_info.heros[0].conf_id, expected)
                assert.equal(clientHeroes.size, 1)
                assert.equal(clientHeroes.get(guid).conf_id, expected)
                assert.equal(cards(), 1)
            } finally {
                fs.writeFileSync(
                    path.join(artifacts, name + '.client-model.json'),
                    JSON.stringify(
                        {
                            sex,
                            boundary:
                                'real normal RPCs with explicit local visual/story completion model; no Unity render or full prologue clear claim',
                            visits: driver.visits,
                            actions: driver.actions,
                            pending,
                            attributeEvidence,
                        },
                        null,
                        2,
                    ) + '\n',
                )
                f.close()
            }
        },
    )
