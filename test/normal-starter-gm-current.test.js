import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-gm-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [
    { createNormalStarterFixture },
    { normalCreatorDriver, applyCurrentHeroPackets },
    { mainHeroConfigId },
    { gmRosterCatalogue },
    { configuration },
    { Tables },
    { Protocol },
    { Game },
] = await Promise.all([
    import('./normal-starter-current-fixture.js'),
    import('./normal-starter-creator-driver.js'),
    import('../src/main-hero.js'),
    import('../src/gm-roster-catalogue.js'),
    import('../src/config.js'),
    import('../src/player.js'),
    import('../src/protocol.js'),
    import('../src/game.js'),
])
console.log('[normal-gm-current-artifacts] ' + artifacts)
const text = (value) => Buffer.from(String(value)).toString('base64')
const gm = (name) => ({ command: text(name) })
function applyHeroCache(protocol, heroes, configToGuid, packets) {
    applyCurrentHeroPackets(protocol, heroes, packets)
    for (const packet of packets) {
        let data
        if (packet.id === 5001) {
            configToGuid.clear() // A fresh consumer model, not a claim about Unity process restart.
            data = protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload).data
        } else if (packet.id === 5008) data = protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
        // Current CheckHeroData updates this index without erasing an older
        // config alias. Both aliases may point to the one current GUID object.
        for (const hero of data?.heros_info?.heros ?? []) configToGuid.set(hero.conf_id, hero.guid)
    }
}
function inventory(state) {
    return {
        heroes: state.player.heros_info.heros.map((hero) => ({ dorm_id: 0, ...hero })),
        acquisition: state.heroAcquisitionCounts ?? {},
        pets: state.pets,
        souls: state.player.soulessence_infos,
        bag: state.player.sbag_infos,
        gold: state.player.basic_info.gold,
        diamond: state.player.basic_info.diamond,
        records: state.recordPets ?? [],
        points: state.world.points,
        groups: state.player.group_mgrs,
        battleInfos: state.player.heros_info.battle_infos,
        ornaments: state.ornaments ?? [],
        taskRecords: state.taskRecords ?? [],
        taskRewards: state.taskAfterReceipts ?? {},
        claims: state.claims ?? [],
    }
}
function coldGame(f, name) {
    f.store.flushPending()
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const game = new Game(protocol, f.store, tables, {
        starterProfile: 'normal',
        clock: () => Math.floor(f.nowMs() / 1000),
        arenaClockMs: f.nowMs,
        rng: () => 0,
    })
    const session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, {
                id: e.id,
                seq: seq++,
                payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
            })
        for (const packet of packets) {
            const d = protocol.byId.get(packet.id)
            protocol.decode(d.rsp, packet.payload)
        }
        return packets
    }
    const packets = call('EnterGame', { open_id: name })
    return { tables, protocol, game, session, call, packets, state: () => f.store.load(session.id).state }
}

for (const sex of [1, 2])
    test(
        'normal actual creator sex' +
            sex +
            ' plus slash giveallheroes preserves one persona through aliases, cold login and later sex edit',
        () => {
            const name = 'normal-gm-creator-sex' + sex
            const f = createNormalStarterFixture(name, {
                starterProfile: 'normal',
                traceDirectory: path.join(artifacts, 'trace'),
            })
            const client = new Map(),
                configToGuid = new Map(),
                driver = normalCreatorDriver(f, (packets) => applyHeroCache(f.protocol, client, configToGuid, packets))
            let evidence, failureEvidence
            try {
                const pending = driver.reachPendingCreator(),
                    guid = pending.persona.guid
                const creation = f.call('PlayerCustomData', {
                    name: text('NrmGM' + sex),
                    wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex },
                })
                applyHeroCache(f.protocol, client, configToGuid, creation)
                driver.finishCreatorActions()
                assert.equal(f.state().player.heros_info.heros.length, 1)
                const before = inventory(f.state())
                const savedBefore = f.store.load(f.session().id)
                let first
                try {
                    first = f.call('AddChat', {
                        target: { chat_type: 2, tid: '0' },
                        msg: text('/giveallheroes'),
                        type: 0,
                    })
                } catch (error) {
                    failureEvidence = {
                        message: error.message,
                        code: error.code,
                        beforeOwned: savedBefore.state.player.heros_info.heros.length,
                        afterOwned: f.state().player.heros_info.heros.length,
                    }
                    assert.deepEqual(
                        f.store.load(f.session().id),
                        savedBefore,
                        'failed GM draft preserves committed ownership, references and reward histories',
                    )
                    throw error
                }
                applyHeroCache(f.protocol, client, configToGuid, first)
                const state = f.state(),
                    avatarIds = [mainHeroConfigId(f.tables, 1), mainHeroConfigId(f.tables, 2)]
                assert.equal(gmRosterCatalogue(f.tables).heroes.length, 23)
                assert.equal(
                    state.player.heros_info.heros.length,
                    22,
                    'one normal persona plus21 ordinary configurations covers the23-entry GM catalogue',
                )
                assert.equal(state.player.heros_info.heros.filter((hero) => avatarIds.includes(hero.conf_id)).length, 1)
                assert.equal(state.player.heros_info.heros.filter((hero) => hero.type === 1).length, 1)
                assert.equal(state.player.heros_info.heros.find((hero) => hero.type === 1).guid, guid)
                assert.equal(client.size, 22)
                assert.equal(client.get(guid).conf_id, mainHeroConfigId(f.tables, sex))
                assert.equal(configToGuid.get(mainHeroConfigId(f.tables, sex)), guid)
                assert.deepEqual(
                    state.player.heros_info.heros.find((hero) => hero.guid === guid),
                    before.heroes[0],
                )
                const after = inventory(state)
                f.call('GMCommand', gm('allheroes'))
                f.call('AddChat', { target: { chat_type: 2, tid: '0' }, msg: text('/giveallheroes'), type: 0 })
                assert.deepEqual(inventory(f.state()), after)
                const cold = coldGame(f, name)
                const coldClient = new Map(),
                    coldConfigToGuid = new Map()
                applyHeroCache(cold.protocol, coldClient, coldConfigToGuid, cold.packets)
                assert.equal(coldClient.size, 22)
                assert.equal([...coldClient.values()].filter((hero) => hero.type === 1).length, 1)
                assert.equal(coldClient.get(guid).conf_id, mainHeroConfigId(cold.tables, sex))
                assert.deepEqual(inventory(cold.state()), after)
                cold.call('GMCommand', gm('giveallheroes'))
                cold.call('GMCommand', gm('allheroes'))
                assert.deepEqual(inventory(cold.state()), after)
                const targetSex = sex === 1 ? 2 : 1
                const edited = cold.call('PinchFaceDataUp', {
                    ...cold.state().player.basic_info.wardrobe,
                    sex: targetSex,
                })
                const editedHero = cold.state().player.heros_info.heros.find((hero) => hero.guid === guid)
                applyHeroCache(cold.protocol, coldClient, coldConfigToGuid, edited)
                assert.equal(editedHero.conf_id, mainHeroConfigId(cold.tables, targetSex))
                assert.equal(editedHero.type, 1)
                assert.equal(coldClient.size, 22)
                assert.equal(coldClient.get(guid).conf_id, mainHeroConfigId(cold.tables, targetSex))
                for (const id of avatarIds) {
                    assert.equal(coldConfigToGuid.get(id), guid)
                    assert.equal(
                        coldClient.get(coldConfigToGuid.get(id)).conf_id,
                        mainHeroConfigId(cold.tables, targetSex),
                    )
                }
                assert.equal(cold.state().player.heros_info.heros.length, 22)
                assert.equal(
                    cold.state().player.heros_info.heros.filter((hero) => avatarIds.includes(hero.conf_id)).length,
                    1,
                )
                const editedAssets = inventory(cold.state())
                cold.call('GMCommand', gm('allheroes'))
                assert.deepEqual(inventory(cold.state()), editedAssets)
                const coldAgain = coldGame(f, name)
                assert.deepEqual(inventory(coldAgain.state()), editedAssets)
                assert.equal(coldAgain.state().normalStarterAvatar.guid, guid)
                evidence = {
                    sex,
                    guid,
                    gmCatalogue: 23,
                    owned: 22,
                    avatarCount: 1,
                    ordinary: 21,
                    editedSex: targetSex,
                    editedConf: editedHero.conf_id,
                    firstPacketIds: first.map(({ id }) => id),
                    editPacketIds: edited.map(({ id }) => id),
                    coldVerified: true,
                    coldMeaning:
                        'new Game/Tables/Protocol/session over the same flushed memory SQL; no shared state object or Unity restart claim',
                    avatarAliases: avatarIds.map((id) => ({
                        configId: id,
                        guid: coldConfigToGuid.get(id),
                        currentConfig: coldClient.get(coldConfigToGuid.get(id)).conf_id,
                    })),
                }
            } finally {
                fs.writeFileSync(
                    path.join(artifacts, name + '.json'),
                    JSON.stringify({ evidence, failureEvidence }, null, 2) + '\n',
                )
                f.close()
            }
        },
    )

test('explicit sandbox and unversioned legacy retain both avatar prototype assets across the same GM command and cold normal-default login', () => {
    for (const legacy of [false, true]) {
        const name = legacy ? 'legacy-two-avatar-gm' : 'sandbox-two-avatar-gm'
        const f = createNormalStarterFixture(name, {
            starterProfile: legacy ? 'normal' : 'sandbox',
            legacy,
            traceDirectory: path.join(artifacts, 'trace'),
        })
        try {
            if (legacy) {
                const id = f.baseline.player.basic_info.id
                f.store.transact(id, 0, (state) => {
                    for (const [sex, level] of [
                        [1, 3],
                        [2, 4],
                    ])
                        state.player.heros_info.heros.find(
                            (hero) => hero.conf_id === mainHeroConfigId(f.tables, sex),
                        ).hero_lv = level
                })
            }
            f.login()
            const before = inventory(f.state()),
                ids = [mainHeroConfigId(f.tables, 1), mainHeroConfigId(f.tables, 2)]
            assert.equal(before.heroes.filter((hero) => ids.includes(hero.conf_id)).length, 2)
            f.call('GMCommand', gm('giveallheroes'))
            f.call('GMCommand', gm('allheroes'))
            assert.deepEqual(inventory(f.state()), before)
            const cold = coldGame(f, name)
            assert.deepEqual(inventory(cold.state()), before)
            assert.equal(cold.state().player.heros_info.heros.filter((hero) => ids.includes(hero.conf_id)).length, 2)
            assert.equal(cold.state().starterProfile?.mode, legacy ? undefined : 'sandbox')
        } finally {
            f.close()
        }
    }
})
