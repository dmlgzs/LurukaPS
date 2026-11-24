import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { ErrorCode } from '../src/error-codes.js'
import { weeklyQuotaView } from '../src/weekly-dungeons.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
export function weeklyMutationFixture(name, store = new Store(':memory:'), initialize = true) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, r = {}, nonce, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: nonce ?? seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    if (initialize)
        edit((s) => {
            s.player.basic_info.lv = 70
            ;(s.taskRecords ??= []).push({ task_id: 106013, count: 1 })
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: String(now) }
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '10000'
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '999'
            ;(s.taskRecords ??= []).push({ task_id: 106027, count: 1 })
        })
    const complete = (id = 101) => {
        const row = tables.find('dungeon_weekly', id)
        call('MultiCampaignCreate', { dungeon_id: row.dungeonId, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, state().entrust.run)
        edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: plan.marker_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        now += 3
        const s = state(),
            targets = Object.values(s.combat.entities).filter((e) => e.hp > 0)
        call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...targets.map((e) => e.uuid)],
            battle_info: targets.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
            base_time: '0',
        })
        assert.equal(state().entrust.run.battle_complete, true)
        return getEntrustCatalog(tables).chest(id, 'weekly')
    }
    const claim = (box, times = 1, nonce, who) => call('StaminaBoxGet', { box_id: box.id, times }, nonce, who)
    const balance = (id) => BigInt(state().player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0')
    return {
        tables,
        protocol,
        store,
        game,
        call,
        state,
        edit,
        complete,
        claim,
        balance,
        login,
        now: () => now,
        tick: (n) => (now += n),
        session: () => session,
        decode: (packets) =>
            protocol.decode(
                protocol.byName.get('CSProtoStaminaBoxGet').rsp,
                packets.find((p) => p.id === 9974).payload,
            ),
    }
}
