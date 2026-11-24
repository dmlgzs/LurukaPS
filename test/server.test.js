import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { populateParty } from './party-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
test('real TCP login, fragmented requests, heartbeat, HTTP discovery, error isolation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'azur-tcp-diag-')),
        diagnosticsFile = path.join(directory, 'errors.jsonl')
    const logs = []
    const server = await startServer(
        {
            ...configuration(),
            gamePort: 0,
            httpPort: 0,
            database: ':memory:',
            diagnosticsFile,
            diagnosticsForTests: true,
        },
        { warn: (s) => logs.push(s) },
    )
    const socket = net.connect(server.tcp.address().port, '127.0.0.1')
    const reader = new FrameReader(),
        queue = []
    let wake
    socket.on('data', (chunk) => {
        queue.push(...reader.feed(chunk))
        wake?.()
    })
    async function response(id) {
        const end = Date.now() + 4000
        while (Date.now() < end) {
            const i = queue.findIndex((x) => x.id === id)
            if (i >= 0) return queue.splice(i, 1)[0]
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 100)
                wake = () => {
                    clearTimeout(timer)
                    resolve()
                }
            })
        }
        throw Error(`No response ${id}`)
    }
    const send = (name, r, seq) => {
        const e = server.protocol.byName.get('CSProto' + name)
        return encodeFrame({ id: e.id, seq }, server.protocol.encode(e.req, r))
    }
    try {
        await once(socket, 'connect')
        const login = send('EnterGame', { open_id: 'tcp-player' }, 90000)
        socket.write(login.subarray(0, 3))
        socket.write(login.subarray(3))
        const result = await response(5001)
        assert.equal(result.seq, 90000)
        assert.equal(result.error, 0)
        assert(server.protocol.decode('SCEnterGame', result.payload).player_id > 0)
        socket.write(send('Heartbeat', { client_time: { time: '123' } }, 90001))
        const heart = await response(5002)
        assert.equal(server.protocol.decode('CSHeartBeat', heart.payload).client_time.time, '123')
        socket.write(encodeFrame({ id: 65500, seq: 90002 }))
        assert.equal((await response(65500)).error, 1021)
        socket.write(send('Ping', { client_ts: '123456789012345678' }, 90003))
        assert.equal(server.protocol.decode('SCPing', (await response(503)).payload).client_ts, '123456789012345678')
        const pid = server.protocol.decode('SCEnterGame', result.payload).player_id
        server.store.transact(pid, 0, (s) => {
            populateParty(s)
            s.player.basic_info.gold = 100
            s.player.sbag_infos.items = [{ itemid: 400000, itemnum: 2 }]
        })
        const hero = server.store.load(pid).state.player.heros_info.heros[0]
        const upgrade = send('LvUpHero', { hero_id: hero.guid, items: [{ item_id: 400000, item_num: 1 }] }, 90004)
        socket.write(upgrade)
        const first = await response(6001)
        assert.equal(first.error, 0)
        const after = server.store.load(pid)
        socket.write(upgrade)
        const repeated = await response(6001)
        assert.deepEqual(repeated, first)
        assert.deepEqual(server.store.load(pid), after)
        const patchRequest = {
            zoneId: 22,
            buildPipe: 1,
            channel: 'C000',
            jobName: configuration().jobName,
            version: configuration().version,
            hotVersion: '2302423.2302423.2302423.2302423.2302423',
            timestamp: 1790276328,
            udid: '',
            account: '',
            mac: '',
            lang: 'chs',
            subchannel: 'SC000',
            serverTag: 0,
        }
        const patch = await (
            await fetch(`http://127.0.0.1:${server.web.address().port}/version/client/patchV1`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patchRequest),
            })
        ).json()
        assert.equal(patch.data.serverSlots.releaseServer.serverInfo[0].port, server.tcp.address().port)
        assert.equal(patch.data.jobName, patchRequest.jobName)
        assert.equal(patch.data.version, patchRequest.version)
        assert.equal(patch.data.hotSlots.releaseHot, configuration().hotRevision)
        assert.equal(patch.data.isForceHot, configuration().isForceHot)
        assert.equal(patch.data.pkgUrl, configuration().packageUrl)
        const cdn = await (await fetch(`http://127.0.0.1:${server.web.address().port}/version/client/getCdnV1`)).json()
        assert.equal(cdn.data.cdn, configuration().cdnUrl)
        assert.deepEqual(cdn.data.cdnBak, configuration().cdnBackupUrls)
        assert.equal(patch.extra, '')
        assert.equal(patch.data.serverSlots.testServer, undefined)
        assert(logs.some((s) => s.includes('65500')))
        socket.write(
            send(
                'StateUpdate',
                {
                    move_msg: {
                        map_id: server.store.load(pid).state.world.map_id,
                        move: [
                            {
                                uuid: hero.guid,
                                info: { pos: { x: 50000, y: 200, z: -9000 }, angle: 180, timestamp: '1800000000123' },
                            },
                        ],
                    },
                },
                90005,
            ),
        )
        const movement = await response(11074)
        assert.equal(movement.seq, 0)
        const confirmed = server.protocol.decode('StateUpdate', movement.payload).move_msg.move[0]
        assert.equal(confirmed.uuid, hero.guid)
        assert.deepEqual(confirmed.info.pos, { x: 50000, y: 200, z: -9000 })
        assert.equal(confirmed.info.timestamp, '1800000000123')
        socket.write(send('Ping', { client_ts: '88' }, 90008))
        await response(503)
        const delayed = send('LvUpHero', { hero_id: hero.guid, items: [{ item_id: 400000, item_num: 1 }] }, 90006)
        const beforeLate = server.store.load(pid).state.player.sbag_infos.items.find((i) => i.itemid === 400000).itemnum
        socket.write(delayed)
        const delayedResponse = await response(6001)
        assert.equal(delayedResponse.error, 0)
        const afterLate = server.store.load(pid)
        assert.equal(afterLate.state.player.sbag_infos.items.find((i) => i.itemid === 400000).itemnum, beforeLate - 1)
        socket.write(delayed)
        assert.deepEqual(await response(6001), delayedResponse)
        assert.deepEqual(server.store.load(pid), afterLate)
        const beforeStale = server.store.load(pid),
            closed = once(socket, 'close')
        socket.write(send('HatredResetSync', { is_player: true, obj_id: String(pid) }, 89998))
        await closed
        const diagnostic = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map(JSON.parse).at(-1)
        assert.equal(diagnostic.message_id, 10807)
        assert.equal(diagnostic.sequence, 89998)
        assert.equal(diagnostic.replay_high, 90008)
        assert.deepEqual(diagnostic.connection.entry, {
            message_id: 5001,
            sequence: 90000,
            reconnect: false,
            has_server_token: false,
        })
        assert.equal(diagnostic.connection.recent_frames.at(-1).sequence, 89998)
        assert(diagnostic.connection.recent_frames.length <= 16)
        assert.equal(diagnostic.connection.revision, server.runtime.revision)
        assert(!JSON.stringify(diagnostic).includes('tcp-player'))
        assert.deepEqual(server.store.load(pid), beforeStale)
    } finally {
        socket.destroy()
        await server.close()
        assert(directory.startsWith(path.join(os.tmpdir(), 'azur-tcp-diag-')))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
