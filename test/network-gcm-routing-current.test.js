import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { productionMaterials } from '../src/production-materials.js'
import { homeCondition } from '../src/home-grid.js'
import { decompressLz4 } from '../src/compression.js'
import { connectObtGcmClient } from './helpers/obt-gcm-client.js'

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-gcm-routing-'))
    const clients = [],
        warnings = []
    let server,
        now = 1800000000
    try {
        server = await startServer(
            {
                ...configuration(),
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                database: path.join(directory, 'network.sqlite'),
                diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                crcDelay: 0,
                strongEncryption: true,
                stateFlushMs: 60000,
                entryWorldChatNoticeDelayMs: 3600000,
            },
            {
                info() {},
                warn(line) {
                    warnings.push(line)
                },
            },
        )
        server.game.clock = () => now
        assert.equal(server.tcp.address().address, '127.0.0.1')
        assert.equal(server.web.address().address, '127.0.0.1')
        assert.notEqual(server.tcp.address().port, server.web.address().port)
        const connect = async (account) => {
            const client = await connectObtGcmClient(server)
            clients.push(client)
            const logged = await client.login(account)
            assert.equal(logged.entered.frame.error, 0)
            await client.barrier()
            return { client, id: logged.playerId }
        }
        await run({
            server,
            connect,
            warnings,
            setTime(value) {
                now = value
            },
        })
    } finally {
        for (const client of clients) await client.close()
        if (server) await server.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-gcm-routing-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['network.sqlite', 'network.sqlite-journal', 'diagnostics.jsonl'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
}

async function take(client, protocol, name, predicate) {
    const entry = protocol.byName.get(name)
    let index, data
    await client.until(
        () =>
            (index = client.queue.findIndex((frame) => {
                if (frame.id !== entry.id || frame.error) return false
                const decoded = protocol.decode(entry.rsp, frame.payload)
                if (!predicate(decoded, frame)) return false
                data = decoded
                return true
            })) >= 0,
    )
    return { frame: client.queue.splice(index, 1)[0], data }
}

function assertOwnContext(client, other, frame) {
    assert.equal(frame.flag & 6, 4)
    assert.equal(frame.seq, 0, 'business producer emits an unsolicited push')
    assert(frame.pushSeq > 0)
    const authenticated = client.cipher.open(frame.raw)
    assert.deepEqual(frame.flag & 1 ? decompressLz4(authenticated) : authenticated, frame.payload)
    assert.throws(() => other.cipher.open(frame.raw), 'another connection cannot authenticate this push')
}

function assertContinuousCounters(client) {
    const frames = client.trace.filter((frame) => frame.flag & 4)
    assert(frames.length > 2)
    for (let index = 0; index < frames.length; index++)
        assert.equal(
            frames[index].raw.readBigUInt64BE(25),
            BigInt(index),
            'all RPC/peer/tick pushes share this connection counter',
        )
}

test(
    'two current GCM clients route real private chat pushes with recipient-specific keys and compressed bodies',
    { timeout: 60000 },
    async () => {
        await fixture(async ({ server, connect, warnings }) => {
            const a = await connect('gcm-routing-chat-a'),
                b = await connect('gcm-routing-chat-b')
            assert.notDeepEqual(a.client.serverPublicKey, b.client.serverPublicKey)
            const before = server.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n
            for (const [sender, recipient, marker] of [
                [a, b, 'a-to-b:'],
                [b, a, 'b-to-a:'],
            ]) {
                const message = Buffer.from(marker + 'x'.repeat(1536)).toString('base64')
                const sent = await sender.client.call('AddChat', {
                    target: { tid: String(recipient.id), chat_type: 0 },
                    msg: message,
                    type: 0,
                })
                assert.equal(sent.frame.error, 0)
                assert.equal(sent.request.raw[4], 5)
                const received = await take(
                    recipient.client,
                    server.protocol,
                    'CSProtoChatInfoChange',
                    (data) => data.chat?.msg === message,
                )
                const own = await take(
                    sender.client,
                    server.protocol,
                    'CSProtoChatInfoChange',
                    (data) => data.chat?.msg === message,
                )
                assert.equal(received.data.chat.player_id, sender.id)
                assert.equal(received.data.target.tid, String(sender.id))
                assert.equal(own.data.target.tid, String(recipient.id))
                assert.equal(received.frame.flag, 5)
                assert.equal(own.frame.flag, 5)
                // Authentication returns compressed plaintext; the ordinary FrameReader already proved its decoded payload.
                assert.equal(recipient.client.cipher.open(received.frame.raw).length > 0, true)
                assert.throws(() => sender.client.cipher.open(received.frame.raw))
                assert.throws(() => recipient.client.cipher.open(own.frame.raw))
                assert.equal(received.frame.seq, 0)
                assert.equal(own.frame.seq, 0)
                assert(received.frame.pushSeq > 0 && own.frame.pushSeq > 0)
            }
            assert.equal(server.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n, before + 2)
            await a.client.barrier()
            await b.client.barrier()
            assertContinuousCounters(a.client)
            assertContinuousCounters(b.client)
            assert.equal(
                warnings.some((line) => line.startsWith('Framing:') || line.startsWith('Push delivery:')),
                false,
            )
        })
    },
)

test(
    'real production timer settles two current quick recipes and seals tick pushes with each owner context',
    { timeout: 60000 },
    async () => {
        await fixture(async ({ server, connect, setTime, warnings }) => {
            const peers = [await connect('gcm-routing-tick-a'), await connect('gcm-routing-tick-b')]
            assert.notDeepEqual(peers[0].client.serverPublicKey, peers[1].client.serverPublicKey)
            const tables = server.game.tables
            const recipes = tables.get('products').filter((row) => {
                const rewards = parseRewards(row.rewardId)
                return (
                    row.isQuickProduct === 1 &&
                    !row.notReleased &&
                    !row.isNeedPet &&
                    row.time > 0 &&
                    rewards.length === 1 &&
                    rewards[0].itemtype === 33 &&
                    rewards[0].itemnum === 1 &&
                    peers.every((peer) => homeCondition(row.unlockCondition, server.store.load(peer.id).state))
                )
            })
            assert(recipes.length >= 2)
            const jobs = []
            for (let index = 0; index < peers.length; index++) {
                const peer = peers[index],
                    recipe = recipes[index]
                const costs = productionMaterials(tables, recipe, [])
                // Arrange real input inventory only; the actual TCP request creates and pays for the job.
                server.store.transact(peer.id, 0, (state) => grantRewards(tables, state, costs))
                const before = server.store.load(peer.id).state.ornaments?.length ?? 0
                const started = await peer.client.call('SimpleProductStart', { product_id: recipe.id, count: 1 })
                assert.equal(started.frame.error, 0)
                await peer.client.barrier()
                const state = server.store.load(peer.id).state
                assert.equal(state.ornaments?.length ?? 0, before)
                assert.equal(state.simpleProducts.length, 1)
                const job = state.simpleProducts[0]
                assert.equal(job.productId, recipe.id)
                assert.equal(job.start, 1800000000)
                assert.equal(job.seconds, recipe.time)
                jobs.push({
                    ...job,
                    before,
                    accessoryId: tables.find('accessory_customed', parseRewards(recipe.rewardId)[0].itemid).accessoryId,
                })
            }
            assert.notEqual(jobs[0].accessoryId, jobs[1].accessoryId)
            // No RPC or direct game.tick call after this: the existing one-second server interval owns settlement/delivery.
            setTime(Math.max(...jobs.map((job) => job.start + job.seconds)))
            for (let index = 0; index < peers.length; index++) {
                const peer = peers[index],
                    other = peers[1 - index],
                    job = jobs[index]
                const finished = await take(
                    peer.client,
                    server.protocol,
                    'CSProtoSimpleProductFinish',
                    (data) =>
                        data.dels?.includes(job.guid) &&
                        data.reward?.rewards?.some(
                            (reward) => reward.itemtype === 15 && reward.itemid === job.accessoryId,
                        ),
                )
                assertOwnContext(peer.client, other.client, finished.frame)
                const reward = finished.data.reward.rewards.find((item) => item.itemtype === 15)
                const state = server.store.load(peer.id).state
                assert.equal(state.simpleProducts.length, 0)
                assert.equal(state.ornaments.length, job.before + 1)
                assert(
                    state.ornaments.some(
                        (item) => String(item.guid) === String(reward.guid) && item.id === job.accessoryId,
                    ),
                )
            }
            for (const peer of peers) {
                await peer.client.barrier()
                assertContinuousCounters(peer.client)
            }
            assert.equal(
                warnings.some((line) => line.startsWith('Framing:') || line.startsWith('Production update:')),
                false,
            )
        })
    },
)
