import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { lockedDuelSlot } from '../src/handlers/kibo-duel.js'
import { arenaPoint } from '../src/npc-kibo-battle.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
test('CBT3 duel501 initializes the native arena manager and locked formation before ACK without faking a quest pass', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { syncOptimization: false }) // Full-snapshot assertions; NPC lifecycle tests cover deltas.
    let session = {},
        seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }).map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    }
    try {
        call('EnterGame', { open_id: 'duel-501' })
        const graph = new TaskGraphs(tables).get(106010)
        store.transact(session.id, 0, (s) => {
            s.player.group_mgrs = s.player.group_mgrs.filter((m) => m.type !== 6)
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 152, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82, 151, 148, 181, 168, 154, 184, 185],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        session = {}
        const login = call('EnterGame', { open_id: 'duel-501' })
        const arenaLogin = login.find((x) => x.id === 5001).data.data.group_mgrs.find((m) => m.type === 6)
        assert.equal(arenaLogin.cur_group, 1)
        assert.deepEqual(arenaLogin.groups, [])
        const first = call('KiboDuelGetGroup', { u32: 501 })
        assert.deepEqual(
            // Task visibility may publish one battle-pass delta before ACK.
            // Keep all other packets and the arena preparation ordering exact.
            first.filter((x) => x.id !== 18006).map((x) => x.id),
            [5008, 10740, 10751],
        )
        assert.ok(first.filter((x) => x.id === 18006).length <= 1)
        assert.equal(first.at(-1).id, 10751)
        const group = first[1].data.groups.find((g) => g.slot === lockedDuelSlot),
            luaGroup = first[1].data.groups.find((g) => g.slot === 0)
        assert.equal(group.duel_id, 501)
        assert.equal(group.index, 1)
        assert.equal(group.pet_guids.length, 8)
        assert.deepEqual(
            group.pet_guids.slice(0, 3).map((p) => Number(p.id)),
            [500135, 10383, 10384],
        )
        assert(group.pet_guids.slice(0, 3).every((p) => p.is_trial))
        assert.equal(
            store.load(session.id).state.player.heros_info.heros.find((h) => h.guid === group.hero)?.conf_id,
            199001,
        )
        assert.deepEqual(luaGroup.pet_guids, group.pet_guids)
        assert.deepEqual(
            group.hero_skills.map((s) => s.skill_slot),
            [701, 702],
        )
        const arena = first[0].data.group_mgrs.find((m) => m.type === 6),
            saved = arena.groups.find((g) => g.id === lockedDuelSlot)
        assert(saved)
        assert.equal(arena.cur_group, 1)
        assert.deepEqual(
            arena.groups.map((g) => g.id),
            [0, lockedDuelSlot],
        )
        assert.deepEqual(
            protocol.decode('cs.PetDuelGroupInfo', Buffer.from(saved.pet_duel_group_info, 'base64')),
            group,
        )
        assert.deepEqual(
            protocol.decode(
                'cs.PetDuelGroupInfo',
                Buffer.from(arena.groups.find((g) => g.id === 0).pet_duel_group_info, 'base64'),
            ),
            luaGroup,
        )
        const owned = store.load(session.id).state.pets,
            allowed = String(tables.find('kibo_duel', 501).kiboLockList).split('|').map(Number)
        const selected = group.pet_guids.slice(3).map((p) => Number(owned.find((x) => x.guid === p.id)?.config_id))
        assert.equal(selected.length, 5)
        assert(selected.every((id) => allowed.includes(id)))
        assert.equal(new Set(selected).size, 5)
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_values[0], 0)
        store.transact(session.id, 0, (s) => {
            s.kiboDuelGroups[0].hero_skills = []
            s.kiboDuelGroups[lockedDuelSlot].hero_skills = []
        })
        const repeat = call('KiboDuelGetGroup', { u32: 501 })
        assert.deepEqual(repeat[1].data.groups, first[1].data.groups)
        const empty = {
            type: 6,
            group: {
                slot: 1,
                pet_guids: Array.from({ length: 8 }, () => ({})),
                hero_skills: [
                    { skill_id: 19999903, skill_lv: 1, skill_slot: 701, type: 1 },
                    { skill_id: 19999905, skill_lv: 1, skill_slot: 702, type: 1 },
                ],
                duel_id: 501,
            },
        }
        const changed = call('KiboDuelGroupChange', empty)
        assert.deepEqual(
            changed.map((x) => x.id),
            [5008, 11701],
        )
        assert.deepEqual(
            changed[0].data.group_mgrs[0].groups.map((g) => g.id),
            [0, lockedDuelSlot, 1],
        )
        const edited = Array.from({ length: 8 }, () => ({}))
        edited[1] = { is_trial: true, id: '10384' }
        edited[4] = { is_trial: true, id: '10383' }
        call('KiboDuelGroupChange', { type: 6, group: { pet_guids: edited, duel_id: 501 } })
        const afterEdit = store.load(session.id).state.kiboDuelGroups[0]
        assert.equal(afterEdit.hero, group.hero)
        assert.deepEqual(
            afterEdit.pet_guids.map((p) => p.id),
            ['0', '10384', '0', '0', '10383', '0', '0', '0'],
        )
        assert.deepEqual(
            call('KiboDuelGetGroup', { u32: 501 })[1].data.groups.find((g) => g.slot === 0).pet_guids,
            afterEdit.pet_guids,
        )
        const chosen = call('SetKiboDuelCurGroup', { type: 6, cur_group: 0 })
        assert.deepEqual(
            chosen.map((x) => x.id),
            [5008, 11702],
        )
        assert.equal(chosen[0].data.group_mgrs[0].cur_group, 0)
        const savedState = store.load(session.id)
        assert.throws(
            () =>
                call('KiboDuelGroupChange', {
                    type: 6,
                    group: {
                        slot: 0,
                        duel_id: 501,
                        pet_guids: [{ id: '99999999' }, ...Array.from({ length: 7 }, () => ({}))],
                    },
                }),
            /Invalid arena pet/,
        )
        assert.deepEqual(store.load(session.id), savedState)
        session = {}
        const reconnect = call('EnterGame', { open_id: 'duel-501' })
        assert.equal(reconnect.find((x) => x.id === 5001).data.data.group_mgrs.find((m) => m.type === 6).cur_group, 0)
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_values[0], 0)
        const before = store.load(session.id)
        assert.throws(() => call('KiboDuelGetGroup', { u32: 999999 }), /Unknown Kibo duel/)
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})

test('duel501 enters its table-linked arena through one-way 9510 and can leave without a win record', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }).map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    }
    try {
        call('EnterGame', { open_id: 'arena-entry' })
        call('KiboDuelGetGroup', { u32: 501 })
        const before = store.load(session.id).state.world,
            started = call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.deepEqual(
            started.map((x) => x.id),
            [10747, 9512, 9513, 9567, 11874, 11801, 10007, 11804, 11802, 9105, 9103, 11055, 11800],
        )
        assert.deepEqual(
            started.filter((x) => x.id === 11800).map((x) => x.data.status),
            [2],
        )
        assert.equal(started[0].data.id, 501)
        assert.equal(started[3].data.player_list[0].hero_id, 199001)
        assert.equal(started[4].data.infos[0].hero_conf_id, 199001)
        const attrs = started.find((x) => x.id === 10007).data.infos
        assert.equal(attrs.length, 8)
        assert(attrs.every((p) => p.pet_guid.guid !== '0' && p.attrs.attrs.length > 0))
        const firstPet = started.find((x) => x.id === 11802).data.pet_guid
        assert.equal(firstPet, attrs[0].pet_guid.guid)
        assert(started.find((x) => x.id === 11804).data.pet_guids.includes(firstPet))
        const info = started[2].data
        assert.equal(info.dungeon_id, 40007)
        assert.equal(info.status, 2)
        assert.equal(info.map_id, tables.find('kibo_duel_map', 20008).art)
        assert.equal(store.load(session.id).state.world.map_id, info.map_id)
        assert.deepEqual(
            store.load(session.id).state.world.pos,
            arenaPoint(tables, tables.find('kibo_duel_map', 20008), 'nestBorthPos1').pos,
        )
        assert.equal(store.load(session.id).state.multiCampaign.arena_status, 2)
        const history = store.load(session.id).state.worldHistory.length
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.equal(store.load(session.id).state.worldHistory.length, history)
        assert.equal(call('StartDungeonClientOk')[0].id, 9513)
        assert.equal(store.load(session.id).state.multiCampaign.status, 3)
        assert.equal(call('MultiCampaignPlayerLoadFinish').find((x) => x.id === 11800).data.status, 3)
        assert(store.load(session.id).state.kiboDuelLoadingCompleteAt > 0)
        session = {}
        const resumed = call('EnterGame', { open_id: 'arena-entry' })
        assert.ok(!resumed.some((x) => x.id === 11800))
        assert.equal(store.load(session.id).state.world.map_id, before.map_id)
        assert.equal(store.load(session.id).state.multiCampaign, undefined)
        const restarted = call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.equal(restarted.find((x) => x.id === 11800).data.status, 2)
        call('StartDungeonClientOk')
        call('MultiCampaignPlayerLoadFinish')
        const confirmed = call('KiboDuelArenaFirstConfirmReq')
        assert.deepEqual(
            confirmed.map((x) => x.id),
            [11803, 11807, 11800, 11813],
        )
        assert.equal(confirmed.find((x) => x.id === 11803).data.confirm_infos[0].isConfirm, true)
        assert.equal(confirmed.find((x) => x.id === 11800).data.status, 6)
        assert.deepEqual(
            call('KiboDuelArenaFirstConfirmReq').map((x) => x.id),
            [11813],
        )
        const quit = call('MultiCampaignQuit')
        assert(quit.some((x) => x.id === 9103))
        assert.equal(quit.find((x) => x.id === 11055).data.mode, 1)
        assert.equal(store.load(session.id).state.world.map_id, before.map_id)
        assert.equal(store.load(session.id).state.multiCampaign, undefined)
        assert.deepEqual(store.load(session.id).state.kiboDuelRecords ?? {}, {})
    } finally {
        store.close()
    }
})

test('relogin recovers legacy and timed-out READY duel entries without losing fresh entry', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }).map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    }
    try {
        call('EnterGame', { open_id: 'stranded-duel' })
        call('KiboDuelGetGroup', { u32: 501 })
        const home = structuredClone(store.load(session.id).state.world)
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        store.transact(session.id, 0, (s) => {
            delete s.multiCampaign.arena_status
        })
        session = {}
        call('EnterGame', { open_id: 'stranded-duel' })
        const restored = store.load(session.id).state
        assert.equal(restored.multiCampaign, undefined)
        assert.equal(restored.world.map_id, home.map_id)
        assert.deepEqual(restored.world.pos, home.pos)
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        session = {}
        call('EnterGame', { open_id: 'stranded-duel' })
        assert.equal(store.load(session.id).state.world.map_id, home.map_id)
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        store.transact(session.id, 0, (s) => {
            s.multiCampaign.start_time = '1'
        })
        session = {}
        call('EnterGame', { open_id: 'stranded-duel' })
        assert.equal(store.load(session.id).state.world.map_id, home.map_id)
        assert.equal(store.load(session.id).state.multiCampaign, undefined)
    } finally {
        store.close()
    }
})

test('trial arena pet without an owned source gets one persisted table-generated aptitude profile', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'arena-trial-profile' })
        store.transact(session.id, 0, (s) => {
            s.pets = s.pets.filter((p) => p.config_id !== 500134)
        })
        call('KiboDuelGetGroup', { u32: 501 })
        const first = store.load(session.id).state.kiboDuelTrialProfiles[500135]
        assert(first)
        assert.equal(first.lv, 30)
        assert.equal(
            first.comprehension.reduce((n, p) => n + p.level, 0),
            25,
        )
        call('KiboDuelGetGroup', { u32: 501 })
        assert.deepEqual(store.load(session.id).state.kiboDuelTrialProfiles[500135], first)
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        assert.equal(store.load(session.id).state.multiCampaign.arena_status, 2)
    } finally {
        store.close()
    }
})
