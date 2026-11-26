import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { startServer } from '../src/server.js'
import { parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { connectObtClient } from './helpers/obt-tcp-client.js'
import { ObtClientModel } from './helpers/obt-client-model.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

test('current protobuf getter defaults keep omitted zero favor fields numeric in the consumer', () => {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        inventory = new ObtInventoryConsumer(tables, protocol),
        configId = tables.get('hero').find((hero) => hero.favor === 1).id,
        entry = protocol.byName.get('CSProtoSyncPlayerData')
    inventory.consumePackets([
        {
            id: entry.id,
            payload: protocol.encode(entry.rsp, { heros_info: { heros: [{ guid: '1', conf_id: configId }] } }),
        },
    ])
    assert.equal(inventory.favor(configId), 0)
    inventory.consumePackets([
        {
            id: entry.id,
            payload: protocol.encode(entry.rsp, {
                heros_info: { heros: [{ guid: '1', conf_id: configId, favorability_lv: 1 }] },
            }),
        },
    ])
    assert.equal(
        inventory.favor(configId),
        tables.get('hero_favorability_exp').find((row) => row.favorabilityLevel === 0).favorabilityExp,
    )
})

for (const strongEncryption of [false, true])
    test(
        `1.0.0 loopback TCP login, fragmented/coalesced frames, current rewards and reconnect; strong=${strongEncryption}`,
        { timeout: 60000 },
        async (t) => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-obt-network-')),
                clients = [],
                warnings = [],
                config = {
                    ...configuration(),
                    host: '127.0.0.1',
                    publicHost: '127.0.0.1',
                    gamePort: 0,
                    httpPort: 0,
                    database: path.join(directory, 'network.sqlite'),
                    diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                    crcDelay: 0,
                    strongEncryption,
                    stateFlushMs: 60000,
                    entryWorldChatNoticeDelayMs: 3600000,
                    cdnUrl: '',
                    cdnBackupUrls: [],
                }
            let server
            try {
                server = await startServer(config, { warn: (line) => warnings.push(line), info: () => {} })
                server.game.clock = () => 1800000000
                assert.equal(server.tcp.address().address, '127.0.0.1')
                assert.equal(server.web.address().address, '127.0.0.1')
                const base = `http://127.0.0.1:${server.web.address().port}`,
                    post = async (endpoint, body = {}) => {
                        const response = await fetch(base + endpoint, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify(body),
                            signal: AbortSignal.timeout(8000),
                        })
                        assert.equal(response.status, 200)
                        const data = await response.json()
                        assert.equal(data.code, 0)
                        return data
                    }
                for (const suffix of ['getCdnV1', 'v1_0/getcdn']) {
                    const cdn = await post('/version/client/' + suffix)
                    assert.equal(cdn.data.cdn, base + '/')
                    assert.deepEqual(cdn.data.cdnBak, [])
                }
                for (const suffix of ['preDownloadConfV1', 'v1_0/predownloadconf']) {
                    const download = await post('/version/client/' + suffix)
                    assert.equal(download.data.jobName, config.jobName)
                    assert.equal(download.data.formal, null)
                    assert.equal(download.data.gray, null)
                }
                for (const suffix of ['getAccountV1', 'v1_0/getaccount']) {
                    const account = await post('/version/client/' + suffix, {
                        zoneId: 22,
                        serverTag: 0,
                        account: 'network-account',
                    })
                    assert.equal(account.data.isOld, true)
                    if (suffix.startsWith('v1_0')) assert.equal(account.data.account, 'network-account')
                }
                assert.equal(
                    server.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n,
                    0,
                    'Resource classification is not account authentication',
                )
                const patch = await post('/version/client/v1_0/patch', {
                    version: '1.0.0',
                    jobName: config.jobName,
                    zoneId: 22,
                    buildPipe: 1,
                })
                assert.equal(patch.data.version, config.version)
                assert.equal(patch.data.serverSlots.releaseServer.serverInfo[0].port, server.tcp.address().port)

                const protocol = server.protocol,
                    tables = server.game.tables,
                    inventory = new ObtInventoryConsumer(tables, protocol),
                    model = new ObtClientModel(tables, protocol),
                    client = await connectObtClient(server, [inventory, model])
                clients.push(client)
                const playerId = await client.login(`network-current-${strongEncryption}`)
                model.assertHeroReferences()
                assert.equal(!!client.key, strongEncryption)
                if (strongEncryption) {
                    assert.equal(client.trace.find((frame) => frame.id === 5014).flag, 0)
                    assert(client.trace.some((frame) => frame.id === 10006 && frame.flag === 2))
                }
                client.send('MapLoadFinish')
                await client.barrier()
                model.assertSceneModeConfigured()
                assert.equal(
                    client.trace.some((frame) => frame.id === 9151),
                    false,
                )
                const state = () => server.store.load(playerId).state,
                    box = tables
                        .get('common_item')
                        .find(
                            (row) =>
                                row.useType === 3 &&
                                row.giftBagReward &&
                                parseRewards(row.giftBagReward).every(
                                    (entry) => entry.itemtype === 3 && tables.find('common_item', entry.itemid),
                                ),
                        ),
                    choice = parseRewards(box.giftBagReward)[0],
                    gift = tables.get('hero_favorability_gift').find((row) =>
                        String(row.favourHero)
                            .split('|')
                            .some((id) => [...inventory.heroes.values()].some((hero) => hero.conf_id === Number(id))),
                    ),
                    heroId = Number(
                        String(gift.favourHero)
                            .split('|')
                            .find((id) => [...inventory.heroes.values()].some((hero) => hero.conf_id === Number(id))),
                    ),
                    hero = [...inventory.heroes.values()].find((hero) => hero.conf_id === heroId),
                    soul = tables.get('soulessence').find((row) => !row.validProfession),
                    custom = tables
                        .get('accessory_customed')
                        .find((row) => tables.find('accessory', row.accessoryId)?.mainAttr),
                    vehicle = tables.get('vehicle')[0],
                    mailId = '9007199254740993'
                server.store.transact(playerId, 0, (draft) =>
                    draft.mail.push({
                        guid: mailId,
                        createtm: 1800000000,
                        read: false,
                        fetch: false,
                        collect: false,
                        title: '',
                        content: '',
                        reward: {
                            rewards: [
                                { itemtype: 3, itemid: box.id, itemnum: 3 },
                                { itemtype: 3, itemid: gift.id, itemnum: 1 },
                                { itemtype: 9, itemid: soul.id, itemnum: 1 },
                                { itemtype: 33, itemid: custom.id, itemnum: 1 },
                                { itemtype: 41, itemid: vehicle.id, itemnum: 1 },
                            ],
                        },
                    }),
                )
                const summary = await client.call('GetMailboxSummary', {
                    known_mailbox_version: String(model.mailbox.version ?? 0n),
                })
                assert.equal(summary.data.code, 0)
                const requests = [
                    client.encode('ListMails', {
                        list_type: 1,
                        limit: 30,
                        known_mailbox_version: summary.data.summary.mailbox_version,
                    }),
                    client.encode('ShopInfoReq', { shop_id: tables.get('shop')[0].shopId }),
                ]
                client.socket.write(Buffer.concat(requests.map((request) => request.raw)))
                for (const request of requests) assert.equal((await client.wait(request.id, request.seq)).error, 0)
                assert(model.mailbox.mails.has(mailId))
                const sync = await client.call('SyncMailbox', {
                    since_version: String(model.mailbox.version),
                    max_deltas: 100,
                })
                assert.equal(sync.data.code, 0)
                inventory.onAck('MailClaim', (cache) => assert.equal(cache.count(box.id), 3))
                const claim = await client.call('MailClaim', {
                    selector: 1,
                    request_id: Buffer.alloc(16, strongEncryption ? 2 : 1).toString('base64'),
                    mails: [{ mail_id: mailId }],
                })
                assert.equal(claim.frame.error, 0)
                assert.equal(claim.data.results[0].status, 3)
                assert.equal(Buffer.from(claim.data.results[0].claim_id, 'base64').length, 16)
                assert.equal(model.claimRewardViews.length, claim.data.results[0].rewards.rewards.length)
                const granted = claim.data.results[0].rewards.rewards,
                    soulGuid = Number(granted.find((row) => row.itemtype === 9).guid),
                    ornamentGuid = Number(granted.find((row) => row.itemtype === 15).guid),
                    vehicleGuid = granted.find((row) => row.itemtype === 41).guid
                model.assertVehicleReady(vehicleGuid)
                await client.barrier()
                const beforeInvalid = structuredClone(state().player.sbag_infos)
                const invalid = await client.call('UseItem', { itemid: box.id, num: 1, args: [3, 0xffffffff] })
                assert.equal(invalid.frame.error, ErrorCode.SelectGiftItemNotExist)
                assert.deepEqual(state().player.sbag_infos, beforeInvalid)
                inventory.onAck('UseItem', (cache) => {
                    assert.equal(cache.count(box.id), 2)
                    assert.equal(cache.count(choice.itemid), choice.itemnum)
                })
                const used = await client.call(
                    'UseItem',
                    { itemid: box.id, num: 1, args: [choice.itemtype, choice.itemid] },
                    { fragment: true },
                )
                assert.equal(used.frame.error, 0)
                const afterUse = server.store.load(playerId)
                client.socket.write(used.request.raw)
                assert.deepEqual(await client.wait(used.request.id, used.request.seq), used.frame)
                assert.deepEqual(server.store.load(playerId), afterUse)
                const favor = inventory.favor(heroId)
                inventory.onAck('SendHeroGift', (cache) => {
                    assert.equal(cache.count(gift.id), 0)
                    assert.equal(cache.favor(heroId), favor + gift.favourValue)
                })
                assert.equal(
                    (await client.call('SendHeroGift', { heroId, item_id: gift.id, item_type: 110, num: 1 })).frame
                        .error,
                    0,
                )
                inventory.onAck('MoveSoulEssence', (cache) => {
                    assert.equal(cache.heroes.get(hero.guid).wguid, soulGuid)
                    cache.equipment(hero.guid)
                })
                assert.equal(
                    (await client.call('MoveSoulEssence', { hero_id: hero.guid, guid: soulGuid })).frame.error,
                    0,
                )
                inventory.onAck('MoveOrnament', (cache) => cache.equipment(hero.guid))
                assert.equal(
                    (await client.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: ornamentGuid })).frame
                        .error,
                    0,
                )
                assert.equal((await client.call('SetVehicleRoulettePos', { guid: vehicleGuid, pos: 2 })).frame.error, 0)
                model.assertVehicleReady(vehicleGuid)
                await client.barrier()
                assert.equal(client.trace.filter((frame) => frame.error).length, 1)
                assert(client.trace.filter((frame) => frame.seq === 0).every((frame) => frame.pushSeq > 0))
                assert.equal(client.reader.buffer.length, 0)
                const firstKey = client.key
                await client.close()
                const reloadedInventory = new ObtInventoryConsumer(tables, protocol),
                    reloadedModel = new ObtClientModel(tables, protocol),
                    reconnect = await connectObtClient(server, [reloadedInventory, reloadedModel])
                clients.push(reconnect)
                assert.equal(await reconnect.login(`network-current-${strongEncryption}`, true), playerId)
                reloadedModel.assertHeroReferences()
                reloadedModel.assertVehicleReady(vehicleGuid)
                reloadedInventory.equipment(hero.guid)
                assert.equal(reloadedInventory.heroes.get(hero.guid).wguid, soulGuid)
                assert.equal(reloadedInventory.count(box.id), 2)
                assert.equal(reloadedInventory.count(gift.id), 0)
                assert.equal(reloadedInventory.favor(heroId), favor + gift.favourValue)
                if (strongEncryption) assert.notDeepEqual(reconnect.key, firstKey)
                assert.equal(fs.existsSync(config.database), true)
                assert.equal(
                    warnings.some((line) => line.startsWith('Framing:')),
                    false,
                )
                assert(warnings.some((line) => line.includes('Selected item is not in this gift')))
                t.diagnostic(
                    JSON.stringify({
                        strongEncryption,
                        headerSize: 25,
                        cryptoStart: 7,
                        httpRequests: 7,
                        receivedFrames: client.trace.length,
                        reconnectFrames: reconnect.trace.length,
                        encryptedFrames: client.trace.filter((frame) => frame.flag & 2).length,
                        errorReplies: client.trace
                            .filter((frame) => frame.error)
                            .map((frame) => ({ id: frame.id, error: frame.error })),
                        requestReplies: client.trace.filter((frame) => frame.seq).map((frame) => frame.id),
                        keyRotatedOnReconnect: strongEncryption ? !reconnect.key.equals(firstKey) : false,
                    }),
                )
            } finally {
                for (const client of clients) await client.close()
                if (server) {
                    await server.close()
                    assert.equal(server.tcp.listening, false)
                    assert.equal(server.web.listening, false)
                    assert.equal(server.store.db.open, false)
                }
                const parent = path.resolve(os.tmpdir()) + path.sep
                assert(path.resolve(directory).startsWith(parent + 'lurukaps-obt-network-'))
                for (const name of fs.readdirSync(directory)) {
                    assert(['network.sqlite', 'network.sqlite-journal', 'diagnostics.jsonl'].includes(name))
                    fs.unlinkSync(path.join(directory, name))
                }
                fs.rmdirSync(directory)
            }
        },
    )
