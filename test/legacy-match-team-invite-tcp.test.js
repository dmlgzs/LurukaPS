import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
import { configuration } from '../src/config.js'
import { ErrorCode } from '../src/error-codes.js'

test('real TCP invitations follow the current authenticated socket owner through account takeover and disconnect', async () => {
    const warnings = [],
        clients = []
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
    async function connect(account) {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            reader = new FrameReader(),
            queue = []
        let sequence = 1
        socket.on('error', () => {})
        socket.on('data', (chunk) => queue.push(...reader.feed(chunk)))
        const client = {
            socket,
            queue,
            send: (name, value = {}) => {
                const entry = server.protocol.byName.get('CSProto' + name)
                socket.write(encodeFrame({ id: entry.id, seq: sequence++ }, server.protocol.encode(entry.req, value)))
            },
            next: async (id) => {
                const limit = Date.now() + 8000
                while (Date.now() < limit) {
                    const index = queue.findIndex((frame) => frame.id === id)
                    if (index >= 0) return queue.splice(index, 1)[0]
                    await new Promise((resolve) => setTimeout(resolve, 5))
                }
                throw Error('Missing isolated TCP response ' + id)
            },
        }
        clients.push(client)
        await once(socket, 'connect')
        client.send('EnterGame', { open_id: account })
        const login = await client.next(5001)
        assert.equal(login.error, 0)
        client.id = server.protocol.decode(server.protocol.byId.get(5001).rsp, login.payload).player_id
        return client
    }
    try {
        const captain = await connect('legacy-tcp-captain'),
            firstPeer = await connect('legacy-tcp-peer')
        const material = server.game.tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
        captain.send('CreateMatchTeam', { dungeon_id: material.dungeonId, scene_type: 12 })
        await captain.next(9520)
        const request = { pid: firstPeer.id, position: 1, dungeon_id: material.dungeonId }
        captain.send('InviteJoin', request)
        const invitation = await firstPeer.next(9521)
        assert.equal(invitation.error, 0)
        assert.equal(
            server.protocol.decode(server.protocol.byId.get(9521).rsp, invitation.payload).invite.pid,
            captain.id,
        )
        const oldClosed = new Promise((resolve) => firstPeer.socket.once('close', resolve))
        const replacement = await connect('legacy-tcp-peer')
        assert.equal(replacement.id, firstPeer.id)
        await oldClosed
        assert.equal(server.game.legacyMatchTeams.isOnline(replacement.id), true)
        assert.equal(
            server.game.legacyMatchTeams.invitationFor(replacement.id),
            null,
            'new client cannot resume old expiry UI',
        )
        captain.send('InviteJoin', request)
        assert.equal((await replacement.next(9521)).error, 0)
        const closed = new Promise((resolve) => replacement.socket.once('close', resolve))
        replacement.socket.destroy()
        await closed
        const limit = Date.now() + 3000
        while (server.game.legacyMatchTeams.isOnline(replacement.id) && Date.now() < limit)
            await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(server.game.legacyMatchTeams.isOnline(replacement.id), false)
        assert(
            server.game.abyssTickOwners.has(replacement.id),
            'retained abyss session is deliberately not presence authority',
        )
        captain.send('InviteJoin', request)
        assert.equal((await captain.next(9525)).error, ErrorCode.PlayerNotOnline)
        assert(warnings.some((line) => line.includes('Invited player is offline')))
    } finally {
        for (const client of clients) client.socket.destroy()
        await server.close()
    }
})
