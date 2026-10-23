import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
import { abyssBattlePlan } from '../src/abyss-battle-config.js'

test('the existing one-second TCP scheduler pushes an abyss idle defeat with no following request and no duplicate result', async () => {
    const config = configuration()
    const server = await startServer({ ...config, gamePort: 0, httpPort: 0, database: ':memory:' }, { warn: () => {} })
    let now = 1800000000,
        sent = 0
    server.game.clock = () => now
    const protocol = server.protocol,
        socket = net.connect(server.tcp.address().port, '127.0.0.1')
    const reader = new FrameReader(),
        queue = []
    socket.on('data', (chunk) => queue.push(...reader.feed(chunk)))
    async function receive(id) {
        const until = Date.now() + 5000
        while (Date.now() < until) {
            const index = queue.findIndex((frame) => frame.id === id)
            if (index >= 0) return queue.splice(index, 1)[0]
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw Error('Abyss TCP packet timeout: ' + id)
    }
    function send(name, request) {
        const entry = protocol.byName.get('CSProto' + name)
        socket.write(encodeFrame({ id: entry.id, seq: ++sent }, protocol.encode(entry.req, request)))
    }
    try {
        await once(socket, 'connect')
        send('EnterGame', { open_id: 'abyss-idle-tcp' })
        const account = protocol.decode(
            protocol.byName.get('CSProtoEnterGame').rsp,
            (await receive(5001)).payload,
        ).player_id
        server.store.transact(account, 0, (state) => {
            state.tasks = []
            state.taskRecords = server.game.tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
            Object.assign(state.world, server.game.tables.position(server.game.tables.find('world_borthpos', 20005)))
        })
        const hero = server.store.load(account).state.player.heros_info.heros[0].guid
        send('AbyssChallenge', {
            mode: 1,
            abyss_level: 10001,
            challenge_list: [
                {
                    dungeon_id: 34760,
                    control: hero,
                    heros: [
                        { index: 0, hero: { hero_guid: hero, pet_guid: '0' } },
                        { index: 1, hero: { hero_guid: '0', pet_guid: '0' } },
                        { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
                    ],
                },
            ],
        })
        assert.equal((await receive(11451)).error, 0)
        send('AbyssChallengeRealStart', {})
        assert.equal((await receive(11462)).error, 0)
        const run = server.store.load(account).state.abyssRun
        const maximum = abyssBattlePlan(server.game.tables, run.dungeon_id).limit
        now = run.real_start_time + maximum
        const packet = await receive(11461)
        const end = protocol.decode(protocol.byName.get('CSProtoAbyssDungeonEndSync').rsp, packet.payload)
        assert.equal(packet.seq, 0)
        assert(packet.pushSeq > 0)
        assert.equal(end.state, 4)
        assert.equal(end.star, 0)
        assert.equal(end.total_cost_time, maximum)
        assert.equal(sent, 3)
        assert.equal(server.store.load(account).state.abyssRun.phase, 'lost')
        await new Promise((resolve) => setTimeout(resolve, 1200))
        assert.equal(queue.filter((frame) => frame.id === 11461).length, 0)
        assert.equal(sent, 3)
    } finally {
        socket.destroy()
        await server.close()
    }
})
