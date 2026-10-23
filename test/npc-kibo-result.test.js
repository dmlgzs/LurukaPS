import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { npcArenaStatistics } from '../src/npc-kibo-statistics.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

function fixture() {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now })
    const decode = (packets) =>
        packets.map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    const call = (name, r = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return decode(game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, r) }))
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'npc-duel-results' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 60
    })
    const enter = (id) => {
        const duel = tables.find('kibo_duel', id)
        call('KiboDuelGetGroup', { u32: id })
        if (duel.kiboLock) {
            const group = structuredClone(state().kiboDuelGroups[0])
            const used = new Set(group.pet_guids.filter((p) => !p.is_trial).map((p) => p.id))
            const available = state().pets.filter((pet) => !used.has(pet.guid))
            for (let i = 0; i < group.pet_guids.length; i++)
                if (group.pet_guids[i].id === '0') {
                    const pet = available.shift()
                    group.pet_guids[i] = { id: pet.guid, is_trial: false }
                }
            call('KiboDuelGroupChange', { type: 6, group })
        }
        if (!duel.kiboLock) {
            call('KiboDuelGroupChange', {
                type: 6,
                group: {
                    slot: 1,
                    duel_id: id,
                    hero: state().player.heros_info.heros[0].guid,
                    pet_guids: state()
                        .pets.slice(0, 8)
                        .map((pet) => ({ id: pet.guid, is_trial: false })),
                },
            })
            call('SetKiboDuelCurGroup', { type: 6, cur_group: 1 })
        }
        call('MultiCampaignCreate', { dungeon_id: duel.dungeonId })
        call('StartDungeonClientOk')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        finishPresentation()
    }
    const finishPresentation = () => {
        now = state().combat.npcDuel.intro_until
        return decode(game.tick(session.id, session))
    }
    const win = () => {
        const actors = Object.values(state().combat.npcDuel.actors)
        const source = actors.find((actor) => actor.camp === 1 && state().combat.npcDuel.in_fight[actor.uuid]).uuid
        const enemies = actors.filter((actor) => actor.camp === 2)
        const summon = (enemy) =>
            call('PVEEnemySummonReq', {
                pet_guid: enemy.uuid,
                pos: state().combat.npcDuel.positions.enemySummon.pos,
                angle: enemy.angle,
            })
        const kill = (enemy) =>
            call('BattleInfoReduce', {
                uint64_dic: [source, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
            })
        summon(enemies[0])
        for (let i = 0; i < enemies.length - 1; i++) {
            now += 20
            summon(enemies[i + 1])
            assert.ok(state().combat.npcDuel.in_fight[enemies[i + 1].uuid])
            kill(enemies[i])
        }
        kill(enemies.at(-1))
        return decode(game.tick(session.id, session))
    }
    return {
        call,
        state,
        enter,
        win,
        store,
        session,
        game,
        finishPresentation,
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: 'npc-duel-results' })
        },
        advance: (n) => {
            now += n
        },
        tick: () => decode(game.tick(session.id, session)),
        close: () => store.close(),
    }
}

test('11850 NPC retries reject a stale world scene without retiring actors or changing the settlement', () => {
    const f = fixture()
    try {
        f.enter(2001)
        f.win()
        const arena = f.state().world.map_id
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignRestart'),
            (error) => error.code === ErrorCode.NotInDungeonMap,
        )
        assert.deepEqual(f.state(), saved)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = arena
        })
        f.call('MultiCampaignRestart')
        assert.equal(f.state().combat.npcDuel.generation, saved.combat.npcDuel.generation + 1)
        f.call('MultiCampaignQuit')
        const left = structuredClone(f.state())
        assert.throws(
            () => f.call('MultiCampaignRestart'),
            (error) => error.code === ErrorCode.NotInMultiCampaign,
        )
        assert.deepEqual(f.state(), left)
    } finally {
        f.close()
    }
})

test('arena damage/healing/kill statistics sync absolute totals, coalesce live updates, and survive result reconnect', () => {
    const f = fixture()
    try {
        f.enter(1001)
        const run = f.state().combat.npcDuel,
            self = Object.values(run.actors).find((actor) => actor.camp === 1 && run.in_fight[actor.uuid]),
            enemy = Object.values(run.actors).find((actor) => actor.camp === 2 && run.in_fight[actor.uuid])
        const hit = (from, target, delta, invalid = false) =>
            f.call('BattleInfoReduce', {
                uint64_dic: [from, target],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } },
                    ...(invalid ? [{ element_info: { op: 1, tar_id: '2' } }] : []),
                ],
            })
        const record = (uuid) => npcArenaStatistics(f.state()).damage_record.find((row) => row.uuid === uuid)
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        const first = hit(self.uuid, enemy.uuid, -12).find((packet) => packet.id === 10756)
        assert.ok(first)
        assert.equal(first.data.damage_record.find((row) => row.uuid === self.uuid).damage, 12)
        assert.equal(record(enemy.uuid).take_damage, 12)
        assert.equal(record(self.uuid).owner_id, String(f.state().player.basic_info.id))
        assert.equal(record(enemy.uuid).owner_id, String(run.npc_id))
        assert.equal(record(self.uuid).camp, 6)
        assert.equal(record(enemy.uuid).camp, 5)
        assert.equal(first.data.damage_record.length, 16)
        assert.equal(hit(self.uuid, enemy.uuid, -8).filter((packet) => packet.id === 10756).length, 0)
        assert.equal(record(self.uuid).damage, 20)
        hit(enemy.uuid, self.uuid, -17)
        hit(self.uuid, self.uuid, 100000)
        assert.equal(record(enemy.uuid).damage, 17)
        assert.equal(record(self.uuid).take_damage, 17)
        assert.equal(record(self.uuid).heal, 17, 'overheal counts only restored HP')
        const saved = structuredClone(f.state().combat.npcDuel)
        assert.throws(() => hit(self.uuid, enemy.uuid, -9, true), /Missing element data/)
        assert.deepEqual(f.state().combat.npcDuel, saved, 'malformed batch cannot leak a partial stat increment')
        f.advance(1)
        const live = f.tick().find((packet) => packet.id === 10756)
        assert.equal(live.data.damage_record.find((row) => row.uuid === self.uuid).damage, 20)
        const left = f.state().combat.entities[enemy.uuid].hp
        hit(self.uuid, enemy.uuid, -100000)
        const total = 20 + left
        assert.equal(record(self.uuid).damage, total, 'overkill counts only accepted HP loss')
        assert.equal(record(self.uuid).kill, 1)
        hit(self.uuid, enemy.uuid, -100000)
        assert.equal(record(self.uuid).damage, total)
        assert.equal(record(self.uuid).kill, 1, 'corpse reports cannot count another kill')
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const finish = f.call('KiboDuelSurrender')
        assert.ok(finish.findIndex((packet) => packet.id === 10756) < finish.findIndex((packet) => packet.id === 11806))
        const expected = npcArenaStatistics(f.state())
        const login = f.relogin()
        assert.deepEqual(
            login.find((packet) => packet.id === 10756).data.damage_record,
            p.decode('cs.KiboDuelStats', p.encode('cs.KiboDuelStats', expected)).damage_record,
        )
        f.call('StartDungeonClientOk')
        const restored = f.call('MultiCampaignPlayerLoadFinish')
        assert.deepEqual(
            restored.find((packet) => packet.id === 10756).data.damage_record,
            login.find((packet) => packet.id === 10756).data.damage_record,
        )
        f.call('MultiCampaignRestart')
        assert.ok(
            npcArenaStatistics(f.state()).damage_record.every(
                (row) => row.damage === 0 && row.kill === 0 && row.heal === 0,
            ),
        )
    } finally {
        f.close()
    }
})

test('real NPC victories grant first/challenge rewards and area progress once, then area rewards are claimable', () => {
    const f = fixture()
    try {
        f.enter(1001)
        const inventory = (id) =>
            f
                .state()
                .player.sbag_infos.items.filter((row) => row.itemid === id)
                .reduce((sum, row) => sum + row.itemnum, 0)
        const before = inventory(402000)
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        assert.throws(() => f.call('KiboDuelBattleFinish', { status: 1, time: 1 }), /not proven/)
        const won = f.win()
        assert.equal(won.find((x) => x.id === 11806).data.result, 1)
        assert.equal(won.find((x) => x.id === 11806).data.star, 0)
        assert.equal(won.find((x) => x.id === 11806).data.clearance_time, '160')
        const progress = won.find((x) => x.id === 10740).data.records.find((record) => record.id === 1001)
        assert.equal(progress.success_time, f.state().kiboDuelRecords[1001].success_time)
        assert.ok(
            Number(progress.success_time) > 0,
            'a win immediately publishes a clear marker even with zero challenge stars',
        )
        assert.equal(f.state().kiboDuelRecords[1001].star, 0)
        assert.equal(f.state().kiboDuelAreas[1].lvl, 1)
        assert.equal(f.state().kiboDuelAreas[1].exp, 30)
        assert.equal(inventory(402000), before + 10)
        assert.equal(won.find((x) => x.id === 6505).data.infos.length, 2)
        assert.ok(f.store.db.prepare('SELECT total_changes() AS n').get().n > writes, 'settlement is durable')
        const receipt = structuredClone(f.state().combat.npcDuel.reward_receipt)
        f.call('KiboDuelBattleFinish', { status: 1 })
        assert.deepEqual(f.state().combat.npcDuel.reward_receipt, receipt)
        assert.equal(inventory(402000), before + 10)
        assert.throws(() => f.call('KiboDuelGetAreaReward', { area: 1, lvl: 2 }), /locked/)
        f.advance(6)
        assert.equal(f.tick().find((x) => x.id === 11800).data.status, 7)
        f.call('MultiCampaignQuit')
        const clearTime = f.state().kiboDuelRecords[1001].success_time
        const login = f.relogin()
        assert.equal(
            login.find((packet) => packet.id === 10740).data.records.find((record) => record.id === 1001).success_time,
            clearTime,
        )
        assert.equal(
            inventory(402000),
            before + 10,
            'world relogin restores progress without repeating first-clear rewards',
        )
        for (const id of [1002, 1003, 1004, 1005]) {
            f.enter(id)
            f.win()
            f.call('MultiCampaignQuit')
        }
        assert.equal(f.state().kiboDuelAreas[1].lvl, 2)
        assert.equal(f.state().kiboDuelAreas[1].exp, 0)
        const pets = f.state().pets.length
        const claim = f.call('KiboDuelGetAreaReward', { area: 1, lvl: 2 }).find((x) => x.id === 10752).data
        assert.equal(claim.src, 117)
        assert.ok(claim.rewards.length)
        assert.equal(f.state().pets.length, pets + 1)
        assert.deepEqual(
            f.call('KiboDuelGetAreaReward', { area: 1, lvl: 2 }).find((x) => x.id === 10752).data.rewards,
            [],
        )
        assert.equal(f.state().pets.length, pets + 1)
    } finally {
        f.close()
    }
})

test('tutorial quest requires the real duel501 success record; timeout and surrender never grant it', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const graph = new TaskGraphs(tables).get(106010)
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 152, s), client_before: true }],
                    finish_nodes: [],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        f.enter(501)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        const loss = f.call('KiboDuelSurrender').find((x) => x.id === 11806).data
        assert.equal(loss.result, 2)
        assert.equal(f.state().kiboDuelRecords?.[501], undefined)
        f.call('MultiCampaignQuit')
        f.enter(501)
        f.advance(300)
        const timeout = f.tick().find((x) => x.id === 11806).data
        assert.equal(timeout.reason, 2)
        assert.equal(timeout.result, 3)
        assert.equal(timeout.clearance_time, '0')
        assert.equal(f.state().kiboDuelRecords?.[501], undefined)
        f.call('MultiCampaignQuit')
        f.enter(501)
        f.win()
        assert.ok(Number(f.state().kiboDuelRecords[501].success_time) > 0)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
    } finally {
        f.close()
    }
})

test('same-scene restart keeps return location and paid receipts while retiring the previous battle identities', () => {
    const f = fixture()
    try {
        f.enter(2001)
        f.win()
        const old = structuredClone(f.state().combat.npcDuel)
        const history = structuredClone(f.state().worldHistory)
        const restarted = f.call('MultiCampaignRestart')
        assert.ok(!restarted.some((packet) => packet.id === 9103), 'restart must not cut the world scene')
        assert.ok(restarted.some((packet) => packet.id === 11065))
        assert.equal(f.state().combat.npcDuel.generation, old.generation + 1)
        assert.deepEqual(f.state().worldHistory, history)
        const enemy = Object.values(old.actors).find((actor) => actor.camp === 2)
        f.call('PVEEnemySummonReq', { pet_guid: enemy.uuid, pos: enemy.pos })
        f.call('KiboCastUltraSkill', { guid: enemy.uuid, cast_ultra_skill: false })
        assert.equal(f.state().combat.npcDuel.in_fight[enemy.uuid], undefined)
        assert.equal(f.state().combat.npcDuel.ultra_choices, undefined)
        f.call('MultiCampaignRestart')
        assert.equal(f.state().combat.npcDuel.generation, old.generation + 1)
        f.call('MultiCampaignPlayerLoadFinish')
        f.call('KiboDuelArenaFirstConfirmReq')
        f.finishPresentation()
        f.win()
        assert.equal(f.state().combat.npcDuel.result.is_first, false)
        assert.equal(
            f
                .state()
                .combat.npcDuel.reward_receipt.rewards.filter((row) => row.itemid === 14)
                .reduce((sum, row) => sum + row.itemnum, 0),
            1500,
        )
    } finally {
        f.close()
    }
})

test('settled arena relogin accepts9602/9604 without reopening the match; explicit restart gets a fresh clock', () => {
    const f = fixture()
    try {
        f.enter(1016)
        f.advance(300)
        f.tick()
        const finished = structuredClone(f.state().combat.npcDuel)
        assert.equal(finished.result.result, 3)
        assert.equal(f.state().multiCampaign.arena_status, 5)
        const reload = (phase) => {
            const login = f.relogin()
            assert.ok(login.findIndex((x) => x.id === 11805) < login.findIndex((x) => x.id === 11806))
            assert.equal(login.find((x) => x.id === 11800).data.status_endtime, String(finished.exit_at))
            f.call('MultiCampaignPlayerLoaded')
            const ready = f.call('MultiCampaignPlayerLoadFinish')
            assert.deepEqual(ready.find((x) => x.id === 11806).data, finished.result)
            assert.deepEqual(
                ready.find((x) => x.id === 11805).data.score_infos,
                [1, 2].map((camp) => ({ camp, score: finished.scores[camp] })),
            )
            assert.ok(ready.findIndex((x) => x.id === 11806) < ready.findIndex((x) => x.id === 11800))
            assert.equal(ready.find((x) => x.id === 11800).data.status, phase)
            f.call('MultiCampaignPlayerLoadingPageComplete')
            assert.equal(f.state().multiCampaign.arena_status, phase)
            assert.equal(f.state().combat.npcDuel.end_at, finished.end_at)
            assert.deepEqual(f.state().combat.npcDuel.reward_receipt, finished.reward_receipt)
            assert.equal(f.state().kiboDuelRecords?.[1016], undefined)
        }
        reload(5)
        f.advance(6)
        f.tick()
        reload(7)
        assert.equal(p.byName.get('CSProtoMultiCampaignRestart').id, 11850)
        f.call('MultiCampaignRestart')
        assert.equal(f.state().multiCampaign.arena_status, 2)
        assert.equal(f.state().combat.npcDuel.generation, finished.generation + 1)
        assert.equal(f.state().combat.npcDuel.result, undefined)
        f.call('MultiCampaignPlayerLoadFinish')
        f.call('KiboDuelArenaFirstConfirmReq')
        f.finishPresentation()
        const firstWindow = Number(
            tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_FIRST_TIME').value,
        )
        assert.equal(f.state().combat.npcDuel.end_at, finished.end_at + 300 + 6 + firstWindow)
        f.advance(1)
        f.tick()
        assert.equal(f.state().multiCampaign.arena_status, 4)
        assert.equal(f.state().combat.npcDuel.result, undefined)
    } finally {
        f.close()
    }
})

test('NPC AI respects trainer pause but guide summons still work; empty-field pressure is timed and durable only at settlement', () => {
    const f = fixture()
    try {
        f.enter(501)
        const run = f.state().combat.npcDuel
        const enemy = Object.values(run.actors).find((actor) => actor.camp === 2 && run.in_fight[actor.uuid])
        const source = Object.values(run.actors).find((actor) => actor.camp === 1 && run.in_fight[actor.uuid]).uuid
        f.call('ControlMapAI', { control_type: 1, status: 1 })
        f.call('BattleInfoReduce', {
            uint64_dic: [source, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
        })
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        f.advance(5)
        f.tick()
        assert.equal(f.state().combat.npcDuel.scores[2], 750)
        assert.equal(Object.keys(f.state().combat.npcDuel.in_fight).length, 1)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const next = Object.values(run.actors).find((actor) => actor.camp === 2 && actor.uuid !== enemy.uuid)
        f.call('PVEEnemySummonReq', { pet_guid: next.uuid, pos: run.positions.enemySummon.pos, angle: next.angle })
        assert.ok(f.state().combat.npcDuel.in_fight[next.uuid], 'guide explicitly deploys while trainer AI is stopped')
        f.call('ControlMapAI', { control_type: 1, status: 2 })
        f.advance(1)
        f.tick()
        assert.equal(Object.keys(f.state().combat.npcDuel.in_fight).filter((id) => run.actors[id].camp === 2).length, 2)
        assert.equal(f.state().combat.npcDuel.scores[2], 750)
    } finally {
        f.close()
    }
})

test('a failed empty-field settlement cannot leak experience or score changes from the small runtime draft', () => {
    const f = fixture()
    try {
        f.enter(501)
        const run = f.state().combat.npcDuel
        const enemy = Object.values(run.actors).find((actor) => actor.camp === 2 && run.in_fight[actor.uuid])
        const source = Object.values(run.actors).find((actor) => actor.camp === 1 && run.in_fight[actor.uuid]).uuid
        f.call('ControlMapAI', { control_type: 1, status: 1 })
        f.call('BattleInfoReduce', {
            uint64_dic: [source, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } }],
        })
        f.game.tables = {
            dir: tables.dir,
            get: tables.get.bind(tables),
            find: (name, id) => {
                const value = tables.find(name, id)
                return name === 'kibo_duel' && id === 501
                    ? { ...value, commonReward: '10#14#100|3#4294967295#1' }
                    : value
            },
        }
        const before = structuredClone(f.state())
        const writes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        f.advance(40)
        assert.throws(() => f.tick(), /Unknown reward item/)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        f.game.tables = tables
        const win = f.tick().find((packet) => packet.id === 11806)
        assert.equal(win.data.result, 1)
        assert.ok(Number(f.state().kiboDuelRecords[501].success_time) > 0)
    } finally {
        f.close()
    }
})

test('configured remaining-time challenges award their drops once while repeat wins only grant common rewards', () => {
    const f = fixture()
    try {
        f.enter(2001)
        f.win()
        const sumExp = () =>
            f
                .state()
                .combat.npcDuel.reward_receipt.rewards.filter((row) => row.itemtype === 10 && row.itemid === 14)
                .reduce((sum, row) => sum + row.itemnum, 0)
        assert.equal(f.state().kiboDuelRecords[2001].star, 7)
        assert.equal(sumExp(), 2850)
        f.call('MultiCampaignQuit')
        f.enter(2001)
        f.win()
        assert.equal(f.state().combat.npcDuel.result.is_first, false)
        assert.equal(sumExp(), 1500)
        assert.equal(f.state().kiboDuelChallengeClaims[2001], 7)
    } finally {
        f.close()
    }
})
