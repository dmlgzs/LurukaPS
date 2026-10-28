import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)

export function noviceDuelFixture(name, { file = ':memory:' } = {}) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(file),
        game = new Game(p, store, tables, { clock: () => now })
    const decode = (packets) =>
        packets.map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    const call = (name, r = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return decode(game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, r) }))
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
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
    const prepareWin = () => {
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
        const enemy = enemies.at(-1)
        return () => kill(enemy)
    }
    return {
        call,
        state,
        enter,
        prepareWin,
        win: () => {
            prepareWin()()
            return decode(game.tick(session.id, session))
        },
        store,
        get session() {
            return session
        },
        game,
        tables,
        protocol: p,
        now: () => now,
        finishPresentation,
        relogin: () => {
            session = {}
            return call('EnterGame', { open_id: name })
        },
        advance: (n) => {
            now += n
        },
        tick: () => decode(game.tick(session.id, session)),
        close: () => store.close(),
    }
}
