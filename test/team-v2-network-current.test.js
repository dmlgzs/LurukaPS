import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { ErrorCode } from '../src/error-codes.js'
import { connectObtClient } from './helpers/obt-tcp-client.js'

test(
    'current TeamV2 TCP invite, target votes, idle expiry and presence follow entered socket owners through reconnect',
    { timeout: 60000 },
    async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-team-v2-network-')),
            clients = [],
            warnings = [],
            config = {
                ...configuration(),
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                database: ':memory:',
                diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                crcDelay: 0,
                strongEncryption: true,
                entryWorldChatNoticeDelayMs: 3600000,
            }
        let server,
            now = 1800000000
        try {
            server = await startServer(config, { warn: (line) => warnings.push(line), info: () => {} })
            server.game.clock = () => now
            assert.equal(server.tcp.address().address, '127.0.0.1')
            assert.equal(server.web.address().address, '127.0.0.1')
            const decode = (frame) => server.protocol.decode(server.protocol.byId.get(frame.id).rsp, frame.payload)
            const next = async (client, id, predicate = () => true) => {
                for (let count = 0; count < 20; count++) {
                    const frame = await client.wait(id)
                    assert.equal(frame.error, 0)
                    const value = decode(frame)
                    if (predicate(value)) return value
                }
                assert.fail('Too many unmatched current team notifications: ' + id)
            }
            const connect = async (account, reconnect = false) => {
                const client = await connectObtClient(server)
                clients.push(client)
                client.id = await client.login(account, reconnect)
                return client
            }
            const qualify = async (client, suffix) => {
                const state = server.store.load(client.id).state
                assert.equal(state.starterProfile.mode, 'normal')
                assert.equal(state.player.heros_info.heros.length, 1)
                assert.equal(state.pets.length, 0)
                const customized = await client.call('PlayerCustomData', {
                    name: Buffer.from('冒险者' + suffix).toString('base64'),
                    wardrobe_info: { ...state.player.basic_info.wardrobe, sex: 2 },
                })
                assert.equal(customized.frame.error, 0)
                // Explicit existing post-main qualification; no fabricated team,
                // menu flags, pet assets, actual dungeon win or network user data.
                server.store.transact(client.id, 0, (saved) => {
                    saved.tasks = []
                    saved.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013].map((task_id) => ({
                        task_id,
                        count: 1,
                        time: 1799999999,
                    }))
                    saved.player.basic_info.lv = 40
                    Object.assign(
                        saved.world,
                        server.game.tables.position(server.game.tables.find('world_borthpos', 10045)),
                    )
                    saved.entrust ??= { records: {}, starRewards: [], nextInstanceId: 1 }
                    saved.entrust.records = {
                        ...saved.entrust.records,
                        3: { entrust_star: 1 },
                        5: { entrust_star: 1 },
                        8: { entrust_star: 1 },
                    }
                })
                client.send('WorldTimeSync', { world_time: 123 })
                await client.barrier()
                assert.equal(server.game.teamV2.isOnline(client.id), true)
            }
            const captain = await connect('team-v2-network-captain'),
                peer = await connect('team-v2-network-peer')
            await qualify(captain, '甲')
            await qualify(peer, '乙')
            captain.send('TeamV2CreateTeam', {
                player_id: captain.id,
                typ: 101,
                target: { dungeon_system_id: 10101 },
                limit: { level: 0 },
            })
            const created = await next(captain, 11823, (value) => value.reason === 1),
                teamId = created.team.team_id
            captain.send('TeamV2InviteJoinTeam', { team_id: teamId, player_id: peer.id })
            const invited = await next(peer, 11859, (value) => value.reason === 10)
            assert.equal(invited.invite_join_team.team_id, teamId)
            assert.equal(invited.invite_join_team.target_player, peer.id)
            peer.send('TeamV2ReplyInviteJoin', { team_id: teamId, player_id: peer.id, is_accept: true })
            const joined = await next(peer, 11823, (value) => value.reason === 7)
            await next(captain, 11823, (value) => value.team.member_list.length === 2)
            assert.equal(joined.team.member_list.length, 2)
            const beforeChange = captain.trace.length
            captain.send('TeamV2StartChangeTarget', { team_id: teamId, target: { dungeon_system_id: 10201 } })
            const proposed = await next(peer, 11823, (value) => value.reason === 11)
            assert.equal(proposed.team.change_target.dungeon_system_id, 10201)
            assert.equal(proposed.team.change_vote_time, String(now * 1000))
            await next(captain, 11823, (value) => value.reason === 11)
            peer.send('TeamV2VoteChangeTarget', { team_id: teamId, accept: true })
            for (const client of [captain, peer]) {
                const changed = await next(client, 11823, (value) => value.reason === 13)
                assert.equal(changed.team.target.dungeon_system_id, 10201)
                assert.deepEqual(changed.team.change_vote, [])
            }
            assert.equal(server.game.teamV2.roomFor(captain.id).target.dungeon_system_id, 10201)
            captain.send('TeamV2StartChangeTarget', { team_id: teamId, target: { dungeon_system_id: 10301 } })
            await next(peer, 11823, (value) => value.reason === 11)
            await next(captain, 11823, (value) => value.reason === 11)
            // Advance only the injected clock. The actual server timer must
            // expire this proposal without any subsequent gameplay request.
            now += 30
            for (const client of [captain, peer]) {
                const expired = await next(client, 11823, (value) => value.reason === 14)
                assert.equal(expired.team.target.dungeon_system_id, 10201)
                assert.equal(expired.team.change_target, undefined)
            }
            assert.equal(server.game.teamV2.changes.get(teamId).status, 'expired')
            assert(
                !captain.trace
                    .slice(beforeChange)
                    .some((frame) => [11839, 11841, 9536, 9510, 9567, 9103].includes(frame.id)),
            )
            await peer.close()
            const offline = await next(
                captain,
                11825,
                (value) => value.reason === 2 && value.member.player_id === peer.id,
            )
            assert.equal(offline.member.online, false)
            assert.equal(server.game.teamV2.isOnline(peer.id), false)
            assert.equal(server.game.teamV2.roomFor(captain.id).members.length, 2)
            const replacement = await connect('team-v2-network-peer', true)
            assert.equal(replacement.id, peer.id)
            const restored = await next(replacement, 11823, (value) => value.reason === 2)
            assert.equal(restored.team.team_id, teamId)
            assert.equal(restored.team.target.dungeon_system_id, 10201)
            const online = await next(
                captain,
                11825,
                (value) => value.reason === 1 && value.member.player_id === peer.id,
            )
            assert.equal(online.member.online, true)
            replacement.send('TeamV2LeaveTeam', { team_id: teamId })
            await next(replacement, 11826, (value) => value.player_id === replacement.id)
            await next(captain, 11826, (value) => value.player_id === replacement.id)
            assert.equal(server.game.teamV2.roomFor(replacement.id), null)
            await replacement.close()
            // A local close can precede the server's TCP close event. Once the
            // member has left there is no room presence notification to await.
            const closeDeadline = Date.now() + 3000
            while (server.game.teamV2.isOnline(peer.id) && Date.now() < closeDeadline)
                await new Promise((resolve) => setTimeout(resolve, 5))
            assert.equal(server.game.teamV2.isOnline(peer.id), false)
            const rejected = await captain.call('TeamV2InviteJoinTeam', { team_id: teamId, player_id: peer.id })
            assert.equal(rejected.frame.error, ErrorCode.PlayerNotOnline)
            captain.send('TeamV2DismissTeam', { team_id: teamId })
            await next(captain, 11826, (value) => value.player_id === captain.id)
            assert.equal(server.game.teamV2.roomFor(captain.id), null)
            for (const client of clients) assert(!client.trace.some((frame) => frame.id === 11828))
            assert(!warnings.some((line) => line.includes('TeamV2 presence omitted')))
            assert(!warnings.some((line) => line.includes('TeamV2 proposal maintenance')))
        } finally {
            for (const client of clients) await client.close()
            if (server) {
                await server.close()
                assert.equal(server.tcp.listening, false)
                assert.equal(server.web.listening, false)
                assert.equal(server.store.db.open, false)
            }
        }
    },
)
