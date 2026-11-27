import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { createPets } from '../src/pets.js'
import { connectObtClient } from './helpers/obt-tcp-client.js'

// Transport/handler simulation with explicitly qualified accounts, not a
// natural mainline playthrough or a Unity multiplayer rendering test.
test(
    'current TCP gameplay broadcasts cannot cross two private runs with the same map and local instance ID',
    { timeout: 60000 },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-scene-route-')),
            clients = [],
            warnings = []
        let server
        try {
            server = await startServer(
                {
                    ...configuration(),
                    host: '127.0.0.1',
                    publicHost: '127.0.0.1',
                    gamePort: 0,
                    httpPort: 0,
                    database: ':memory:',
                    diagnosticsFile: path.join(directory, 'errors.jsonl'),
                    crcDelay: 0,
                    strongEncryption: true,
                    entryWorldChatNoticeDelayMs: 3600000,
                },
                { info: () => {}, warn: (line) => warnings.push(line) },
            )
            server.game.clock = () => 1800000000
            const state = (client) => server.store.load(client.id).state,
                decode = (frame) => server.protocol.decode(server.protocol.byId.get(frame.id).rsp, frame.payload),
                connect = async (suffix) => {
                    const client = await connectObtClient(server)
                    clients.push(client)
                    client.id = await client.login('scene-routing-current-' + suffix)
                    const saved = state(client)
                    assert.equal(saved.starterProfile.mode, 'normal')
                    assert.equal(saved.pets.length, 0)
                    assert.equal(
                        (
                            await client.call('PlayerCustomData', {
                                name: Buffer.from('冒险者' + suffix).toString('base64'),
                                wardrobe_info: { ...saved.player.basic_info.wardrobe, sex: 2 },
                            })
                        ).frame.error,
                        0,
                    )
                    server.store.transact(client.id, 0, (draft) => {
                        draft.tasks = []
                        draft.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013].map((task_id) => ({
                            task_id,
                            count: 1,
                            time: 1799999999,
                        }))
                        draft.player.basic_info.lv = 45
                        Object.assign(
                            draft.world,
                            server.game.tables.position(server.game.tables.find('world_borthpos', 10045)),
                        )
                        client.pet = createPets(server.game.tables, draft, 500001, 1)[0].guid
                    })
                    client.send('WorldTimeSync', { world_time: 123 })
                    await client.barrier()
                    return client
                }
            const a = await connect('甲'),
                b = await connect('乙'),
                c = await connect('丙')
            assert.equal(server.game.tables.find('world_city', state(a).world.map_id).type, 1)
            assert.equal(state(a).world.map_id, state(b).world.map_id)
            // Muting chat does not revoke legitimate public-world gameplay.
            assert.equal((await b.call('ChatShieldOp', { tar_id: a.id, op: 1 })).frame.error, 0)
            const action = async (type) => {
                a.send('SwitchPetAction', { uuid: a.pet, type })
                assert.equal((await a.call('SelectEmoticons', { u32: 1 })).frame.error, 0)
                await a.barrier()
                // TCP order plus an acknowledged request on every destination is a
                // delivery barrier; no sleep-based absence assertion is needed.
                await b.barrier()
                await c.barrier()
            }
            let startA = a.trace.length,
                startB = b.trace.length,
                startC = c.trace.length
            await action(1)
            const actions = (client, from) => client.trace.slice(from).filter((frame) => frame.id === 11062)
            assert.equal(actions(a, startA).length, 0)
            assert.deepEqual(actions(b, startB).map(decode), [{ uuid: a.pet, type: 1 }])
            assert.equal(actions(c, startC).length, 1)
            assert(actions(b, startB).every((frame) => frame.flag === 2))
            assert.equal(b.trace.slice(startB).filter((frame) => frame.id === 6583).length, 1)

            for (const client of [a, b]) {
                client.send('MultiCampaignCreate', { dungeon_id: 3580, scene_type: 12 })
                const roster = await client.wait(server.protocol.byName.get('CSProtoMultiCampaignBaseInfoSync').id)
                assert.equal(roster.error, 0)
                assert.equal(roster.seq, 0)
                client.send('MapLoadFinish')
                await client.barrier()
            }
            const runA = state(a).entrust.run,
                runB = state(b).entrust.run
            assert.equal(runA.kind, 'material')
            assert.equal(runA.map_id, runB.map_id)
            assert.equal(runA.instance_id, 1)
            assert.equal(runA.instance_id, runB.instance_id)
            assert.notEqual(state(c).world.map_id, runA.map_id)
            startA = a.trace.length
            startB = b.trace.length
            startC = c.trace.length
            const beforeB = structuredClone(state(b))
            await action(2)
            assert.equal(actions(a, startA).length, 0)
            assert.equal(
                actions(b, startB).length,
                0,
                'independent material instances must not receive one another’s pet actions',
            )
            assert.equal(actions(c, startC).length, 0)
            assert.equal(b.trace.slice(startB).filter((frame) => frame.id === 6583).length, 0)
            assert.deepEqual(state(b), beforeB)

            // World chat remains a separate audience even inside private dungeons.
            assert.equal((await b.call('ChatShieldOp', { tar_id: a.id, op: 2 })).frame.error, 0)
            startB = b.trace.length
            startC = c.trace.length
            const message = Buffer.from('独立副本中的世界频道').toString('base64')
            assert.equal(
                (await a.call('AddChat', { target: { chat_type: 2, tid: '1' }, msg: message, type: 0 })).frame.error,
                0,
            )
            await a.barrier()
            await b.barrier()
            await c.barrier()
            for (const [client, from] of [
                [b, startB],
                [c, startC],
            ])
                assert(
                    client.trace.slice(from).some((frame) => frame.id === 9932 && decode(frame).chat.msg === message),
                )
            // Exiting removes the private route. Same-map public traffic works again.
            for (const client of [a, b]) {
                assert.equal((await client.call('MultiCampaignQuit')).frame.error, 0)
                client.send('MapLoadFinish')
                await client.barrier()
            }
            startB = b.trace.length
            startC = c.trace.length
            await action(3)
            assert.equal(actions(b, startB).length, 1)
            assert.equal(actions(c, startC).length, 1)
            assert.equal(b.trace.slice(startB).filter((frame) => frame.id === 6583).length, 1)
            assert(!warnings.some((line) => /SwitchPetAction:|Push delivery:/.test(line)), warnings.join('\n'))
        } finally {
            for (const client of clients) await client.close()
            await server?.close()
            fs.rmSync(directory, { recursive: true, force: true })
        }
    },
)
