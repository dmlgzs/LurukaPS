import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

export const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
export function targetFixture({ count = 3, file = ':memory:' } = {}) {
    let now = 1800000000,
        sequence = 1,
        store = new Store(file),
        game
    const sessions = Array.from({ length: count }, () => ({})),
        models = new Map()
    const state = (who) => store.load(sessions[who].id).state
    const consume = (who, packets) => {
        for (const packet of packets) {
            if (packet.id !== 11823) continue
            const id = packet.recipient ?? sessions[who].id,
                notice = protocol.decode(protocol.byId.get(11823).rsp, packet.payload)
            let model = models.get(id)
            if (!model) {
                model = { team: null, reasons: [], dialog: null, outcome: null }
                models.set(id, model)
            }
            model.reasons.push(notice.reason)
            // Current UpdateSTeam replaces the complete team only for these reasons.
            if ([0, 1, 2, 7].includes(notice.reason)) model.team = structuredClone(notice.team)
            else model.team.state = notice.team.state
            if (notice.reason === 11 && id !== model.team.captain) {
                model.dialog = {
                    target: notice.team.change_target.dungeon_system_id,
                    deadline:
                        Number(notice.team.change_vote_time) +
                        Number(tables.get('game').find((row) => row.title === 'MULTI_CHANGE_TARGET_CD').value) * 1000,
                }
            }
            if ([12, 13, 14, 15].includes(notice.reason)) {
                model.team.change_vote = [...notice.team.change_vote]
                model.team.change_target = notice.team.change_target
            }
            if ([13, 14, 15].includes(notice.reason)) {
                model.dialog = null
                model.outcome = notice
            }
        }
    }
    const call = (who, name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, name)
        const packets = game.dispatch(sessions[who], {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        })
        consume(who, packets)
        return packets
    }
    const build = () => {
        game = new Game(protocol, store, tables, { clock: () => now })
        game.teamV2.isOnline = (id) => sessions.some((session) => session.id === id && session.entered)
        game.teamV2.connectionKey = (id) =>
            sessions.find((session) => session.id === id && session.entered)?.token ?? null
    }
    build()
    const accounts = sessions.map((_, who) => 'team-v2-change-' + ++targetFixture.counter + '-' + who)
    for (let who = 0; who < count; who++) {
        call(who, 'EnterGame', { open_id: accounts[who] })
        assert.equal(state(who).starterProfile.mode, 'normal')
        assert.equal(state(who).pets.length, 0)
        call(who, 'PlayerCustomData', {
            name: Buffer.from('冒险者' + who).toString('base64'),
            wardrobe_info: { ...state(who).player.basic_info.wardrobe, sex: 2 },
        })
        // Explicit post-main/menu qualification, including the same prior
        // commission stars as the existing lobby fixture. Not naturally earned;
        // no room, proposal, vote or active dungeon run is seeded.
        store.transact(sessions[who].id, 0, (draft) => {
            draft.tasks = []
            draft.taskRecords = [106001, 106002, 106009, 106010, 106012, 106013].map((task_id) => ({
                task_id,
                count: 1,
                time: now - 1,
            }))
            draft.player.basic_info.lv = 45
            draft.entrust ??= { records: {}, starRewards: [], nextInstanceId: 1 }
            Object.assign(draft.entrust.records, {
                3: { entrust_star: 1 },
                5: { entrust_star: 1 },
                8: { entrust_star: 1 },
            })
            Object.assign(draft.world, tables.position(tables.find('world_borthpos', 10045)))
        })
        call(who, 'WorldTimeSync', { world_time: 123 })
    }
    const id = (who) => sessions[who].id,
        room = (who = 0) => game.teamV2.roomFor(id(who))
    const create = (members = count, { typ = 101, target = 10101 } = {}) => {
        call(0, 'TeamV2CreateTeam', {
            player_id: id(0),
            typ,
            target: { dungeon_system_id: target },
            limit: { level: 0 },
        })
        for (let who = 1; who < members; who++) {
            call(0, 'TeamV2InviteJoinTeam', { team_id: room().id, player_id: id(who) })
            call(who, 'TeamV2ReplyInviteJoin', { team_id: room().id, player_id: id(who), is_accept: true })
        }
        return room()
    }
    return {
        get game() {
            return game
        },
        get store() {
            return store
        },
        tables,
        protocol,
        sessions,
        models,
        id,
        state,
        room,
        call,
        create,
        consume,
        now: () => now,
        advance: (seconds) => {
            now += seconds
        },
        propose: (target = 10201, who = 0) =>
            call(who, 'TeamV2StartChangeTarget', { team_id: room(who).id, target: { dungeon_system_id: target } }),
        vote: (who, accept = true) => call(who, 'TeamV2VoteChangeTarget', { team_id: room(who).id, accept }),
        close: () => store.close(),
        reopen: () => {
            assert.notEqual(file, ':memory:')
            const oldIds = sessions.map((session) => session.id)
            store.close()
            store = new Store(file)
            for (let who = 0; who < count; who++) sessions[who] = {}
            build()
            for (let who = 0; who < count; who++) {
                call(who, 'EnterGame', { open_id: accounts[who] })
                assert.equal(id(who), oldIds[who])
                call(who, 'WorldTimeSync', { world_time: 123 })
            }
        },
    }
}
targetFixture.counter = 0
