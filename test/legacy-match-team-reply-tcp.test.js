import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { startServer } from '../src/server.js'
import { configuration } from '../src/config.js'
import { FrameReader, encodeFrame } from '../src/wire.js'

test('real invitation replies create a three-player room and9561 follows actual reconnect/offline ownership', async () => {
    const clients = [],
        warnings = []
    const server = await startServer(
        {
            ...configuration(),
            host: '127.0.0.1',
            publicHost: '127.0.0.1',
            gamePort: 0,
            httpPort: 0,
            database: ':memory:',
            entryWorldChatNoticeDelayMs: 60000,
        },
        { warn: (text) => warnings.push(text), info: () => {} },
    )
    const decode = (frame) => server.protocol.decode(server.protocol.byId.get(frame.id).rsp, frame.payload)
    async function connect(account, loginOnly = false) {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let seq = 1
        socket.on('error', () => {})
        socket.on('data', (chunk) => queue.push(...reader.feed(chunk)))
        const client = {
            socket,
            queue,
            send: (name, value = {}) => {
                const entry = server.protocol.byName.get('CSProto' + name)
                socket.write(encodeFrame({ id: entry.id, seq: seq++ }, server.protocol.encode(entry.req, value)))
            },
            next: async (id) => {
                const limit = Date.now() + 8000
                while (Date.now() < limit) {
                    const index = queue.findIndex((frame) => frame.id === id)
                    if (index >= 0) return queue.splice(index, 1)[0]
                    await new Promise((resolve) => setTimeout(resolve, 5))
                }
                throw Error('Missing isolated room TCP notification ' + id)
            },
        }
        clients.push(client)
        await once(socket, 'connect')
        client.send(loginOnly ? 'Login' : 'EnterGame', { open_id: account })
        const frame = await client.next(loginOnly ? 1001 : 5001)
        assert.equal(frame.error, 0)
        client.id = loginOnly ? decode(frame).pid : decode(frame).player_id
        client.enter = async () => {
            client.send('EnterGame', { open_id: account })
            const entered = await client.next(5001)
            assert.equal(entered.error, 0)
            assert.equal(decode(entered).player_id, client.id)
        }
        return client
    }
    try {
        const captain = await connect('tcp-room-captain'),
            peer = await connect('tcp-room-member')
        const material = server.game.tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
        captain.send('CreateMatchTeam', { dungeon_id: material.dungeonId, scene_type: 12 })
        const room = decode(await captain.next(9520)).team
        captain.send('InviteJoin', { pid: peer.id, position: 1, dungeon_id: material.dungeonId })
        const offer = decode(await peer.next(9521)).invite
        assert.equal(offer.team_id, String(room.team_id))
        peer.send('ReplyInviteJoin', { invite_id: offer.team_id, is_accept: true })
        const joined = decode(await peer.next(9520)).team
        assert.deepEqual(
            joined.members.map((member) => member.pid),
            [captain.id, peer.id],
        )
        assert.deepEqual(joined.online_players, [captain.id, peer.id])
        await captain.next(9520)
        const oldClosed = new Promise((resolve) => peer.socket.once('close', resolve))
        const replacement = await connect('tcp-room-member', true)
        assert.equal(server.game.legacyMatchTeams.isOnline(peer.id), false)
        assert.deepEqual(decode(await captain.next(9561)), { scene_type: 12, player_id: peer.id, status: 1 })
        await replacement.enter()
        const restored = decode(await replacement.next(9520)).team
        assert.equal(restored.team_id, room.team_id)
        assert.deepEqual(restored.online_players, [captain.id, peer.id])
        assert.deepEqual(decode(await captain.next(9561)), { scene_type: 12, player_id: peer.id, status: 0 })
        await oldClosed
        captain.send('Heartbeat', { client_time: { time: '1' } })
        await captain.next(5002)
        assert(
            !captain.queue.some(
                (frame) => frame.id === 9561 && decode(frame).player_id === peer.id && decode(frame).status === 1,
            ),
            'old socket must not mark replacement offline',
        )
        const closed = new Promise((resolve) => replacement.socket.once('close', resolve))
        replacement.socket.destroy()
        await closed
        assert.deepEqual(decode(await captain.next(9561)), { scene_type: 12, player_id: peer.id, status: 1 })
        const third = await connect('tcp-room-third')
        captain.send('InviteJoin', { pid: third.id, position: 2, dungeon_id: material.dungeonId })
        const thirdOffer = decode(await third.next(9521)).invite
        third.send('ReplyInviteJoin', { invite_id: thirdOffer.team_id, is_accept: true })
        const full = decode(await third.next(9520)).team
        assert.deepEqual(
            full.members.map((member) => member.pid),
            [captain.id, peer.id, third.id],
        )
        assert.deepEqual(full.online_players, [captain.id, third.id])
        await captain.next(9520)
        assert.equal(server.game.legacyMatchTeams.roomFor(peer.id).members.length, 3)
        assert.equal(
            warnings.some((text) => text.includes('Legacy team presence omitted')),
            false,
        )
    } finally {
        for (const client of clients) client.socket.destroy()
        await server.close()
    }
})
