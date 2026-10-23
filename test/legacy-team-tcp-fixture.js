import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { startServer } from '../src/server.js'
import { configuration } from '../src/config.js'
import { FrameReader, encodeFrame } from '../src/wire.js'

export async function legacyTeamTCP() {
    const warnings = [],
        clients = [],
        time = { now: 1800000000 }
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
        { warn: (line) => warnings.push(line), info: () => {} },
    )
    server.game.clock = () => time.now
    const decode = (frame) => server.protocol.decode(server.protocol.byId.get(frame.id).rsp, frame.payload)
    async function connect(account) {
        const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
            queue = [],
            reader = new FrameReader()
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
            commit: (target) =>
                socket.write(
                    encodeFrame(
                        { id: 9536, seq: seq++ },
                        server.protocol.encode('cs.ChangeDungeonSync', { dungeon_id: target, ask: false }),
                    ),
                ),
            next: async (id) => {
                const end = Date.now() + 8000
                while (Date.now() < end) {
                    const index = queue.findIndex((frame) => frame.id === id)
                    if (index >= 0) return queue.splice(index, 1)[0]
                    await new Promise((resolve) => setTimeout(resolve, 5))
                }
                throw Error('Missing team protocol frame ' + id)
            },
        }
        clients.push(client)
        await once(socket, 'connect')
        client.send('EnterGame', { open_id: account })
        const login = await client.next(5001)
        assert.equal(login.error, 0)
        client.id = decode(login).player_id
        return client
    }
    const targets = server.game.tables.get('dungeon_crisiscrusade').filter((row) => row.taskUnlock === '2004#1')
    const party = async (count = 2) => {
        const members = []
        for (let i = 1; i <= count; i++) members.push(await connect('target-team-' + i))
        members[0].send('CreateMatchTeam', { dungeon_id: targets[0].dungeonId, scene_type: 12 })
        const room = decode(await members[0].next(9520)).team
        for (let i = 1; i < count; i++) {
            members[0].send('InviteJoin', { pid: members[i].id, position: i, dungeon_id: targets[0].dungeonId })
            const offer = decode(await members[i].next(9521)).invite
            members[i].send('ReplyInviteJoin', { invite_id: offer.team_id, is_accept: true })
            for (let j = 0; j <= i; j++) await members[j].next(9520)
        }
        return { members, room }
    }
    return {
        server,
        time,
        warnings,
        clients,
        connect,
        party,
        targets,
        decode,
        close: async () => {
            for (const client of clients) client.socket.destroy()
            await server.close()
        },
    }
}
