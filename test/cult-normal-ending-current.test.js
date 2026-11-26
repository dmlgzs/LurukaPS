import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { mainHeroConfigId } from '../src/main-hero.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

function open(file, account, nowMs = 1800000000000) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(file),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000), rng: () => 0 })
    let sequence = 1
    const request = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        }
    }
    const dispatch = (frame) => {
        const packets = game.dispatch(session, frame)
        for (const packet of packets) {
            const type = protocol.byId.get(packet.id)?.rsp
            assert(type)
            protocol.decode(type, packet.payload)
        }
        return packets
    }
    const call = (name, value) => dispatch(request(name, value))
    call('EnterGame', { open_id: account })
    return {
        tables,
        protocol,
        store,
        session,
        game,
        request,
        dispatch,
        call,
        state: () => store.load(session.id).state,
        hash: () =>
            createHash('sha256')
                .update(JSON.stringify(store.load(session.id)))
                .digest('hex'),
        nextBattleTime: () => String(++nowMs),
        time: () => nowMs,
        close: () => {
            if (store.db.open) store.close()
        },
    }
}

test('current normal101/201/301 earn battle results and9617 ending once through unmodified finish/permanent callers', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-cult-normal-'))
    const file = path.join(directory, 'state.sqlite'),
        account = 'cult-normal-ending-current'
    let f = open(file, account)
    try {
        // Trusted guide/training baselines only. No trails, accepted receipts, battle results or completed run is injected.
        f.store.transact(f.session.id, 0, (state) => {
            state.taskRecords = f.tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
            state.tasks = []
        })
        f.call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
        const config = f.tables.get('game_events_cul').find((row) => row.Id === 60001)
        const trialIds = [Number(config.trial1), Number(config.trial2), 301]
        assert.deepEqual(trialIds, [101, 201, 301])
        const guid = f.state().activities[60001].growup.guid
        const receipts = []
        let finalRequest
        for (let phase = 1; phase <= 3; phase++) {
            const trialId = trialIds[phase - 1]
            const trial = f.tables
                .get('game_events_cul_trial')
                .find((row) => row.systemId === 60001 && row.trialId === trialId)
            const trainingDays = Array.from(
                { length: phase },
                (_, index) => config[`trainingDayNum${index + 1}`],
            ).reduce((sum, days) => sum + days, 0)
            assert.equal(f.state().activities[60001].growup.cur_stage, phase)
            f.store.transact(f.session.id, 0, (state) => {
                const g = state.activities[60001].growup
                g.cur_growup_stage = trainingDays + 1
                g.cur_growup_trail_stage = phase
                g.growup_train_attr.forEach((attr) => {
                    attr.attr_value = 1000
                })
            })
            const growupBefore = f.state().activities[60001].growup
            assert.equal(growupBefore.trails.length, phase - 1)
            assert.equal(growupBefore.cur_growup_stage, trainingDays + 1)
            if (phase === 3) f.call('SelectCultTrial', { activity_id: 60001, trial_id: trialId })
            const returnMap = f.state().world.map_id
            const entered = f.call('EnterCultTrial', { activity_id: 60001, trial_id: trialId })
            assert(entered.some((packet) => packet.id === 9610))
            assert.equal(f.state().cultTrial.dungeon_id, trial.dungeonId)
            assert.equal(f.state().cultTrial.current_wave, undefined)
            const run = f.state().cultTrial
            const heroPresets = String(config.herointerimid)
                .split('|')
                .map(Number)
                .map((id) => f.tables.find('hero_interim', id))
            const petPresets = String(config.petinterimid)
                .split('|')
                .map(Number)
                .map((id) => f.tables.find('pet_interim', id))
            assert.deepEqual(
                run.heroes.map((hero) => hero.conf_id),
                heroPresets.map((row) =>
                    row.heroType === 1 ? mainHeroConfigId(f.tables, f.state().player.basic_info.sex) : row.heroId,
                ),
            )
            assert.deepEqual(
                run.pets.map((pet) => pet.config_id),
                petPresets.map((row) => row.petId),
            )
            f.call('MultiCampaignPlayerLoaded')
            assert.equal(f.state().cultTrial.current_wave, 1)
            const premature = f.hash()
            assert.throws(
                () => f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: trialId }),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
            assert.equal(f.hash(), premature)
            const waves = f.tables
                .get('game_events_cul_trial_wave')
                .filter((row) => row.trialId === trialId)
                .sort((a, b) => a.waveId - b.waveId)
            assert(waves.length > 0)
            const seen = new Set(),
                groups = new Set()
            for (const wave of waves) {
                const current = f.state(),
                    battle = current.cultTrial
                const objects = String(wave.worldMapId).split('|').map(Number)
                assert.equal(battle.current_wave, wave.waveId)
                const targets = Object.values(current.combat.entities).filter(
                    (entity) => objects.includes(entity.object_id) && entity.hp > 0,
                )
                assert(targets.length)
                for (const object of objects) assert(current.worldObjects[`${battle.map_id}:${object}`].active)
                for (const enemy of targets) {
                    assert(!seen.has(enemy.uuid))
                    seen.add(enemy.uuid)
                    groups.add(enemy.object_id)
                }
                const damage = f.call('BattleInfoReduce', {
                    uint64_dic: [battle.pets[0].guid, ...targets.map((enemy) => enemy.uuid)],
                    battle_info: targets.map((enemy, index) => ({
                        hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: -enemy.hp },
                    })),
                    base_time: f.nextBattleTime(),
                })
                assert(damage.length)
                assert.equal(f.state().cultTrial.completed_waves, wave.waveId)
                for (const object of objects) {
                    const record = f.state().worldObjects[`${battle.map_id}:${object}`]
                    assert.equal(record.complete, true)
                    assert(record.expand_data.battle_group.monsters.every((enemy) => enemy.hp === 0))
                }
            }
            assert.deepEqual(
                [...groups].sort((a, b) => a - b),
                [...new Set(waves.flatMap((wave) => String(wave.worldMapId).split('|').map(Number)))].sort(
                    (a, b) => a - b,
                ),
            )
            const completed = f.state().cultTrial
            assert.equal(completed.battle_complete, true)
            assert.equal(completed.status, 3)
            assert(completed.star >= 1)
            const result = f.state().activities[60001].growup.trails[phase - 1]
            assert.equal(result.trail_id, trialId)
            assert.equal(result.guid, guid)
            assert.equal(result.score, String(completed.score))
            assert.equal(result.star, completed.star)
            const receipt = `${guid}:${trialId}`
            assert.equal(f.state().acceptedCultTrials?.[receipt], undefined)
            const confirmation = f.request('CultTrialSwitchStep', { activity_id: 60001, trial_id: trialId })
            if (phase === 3) {
                const before = f.hash(),
                    encode = f.protocol.encode
                const type = f.protocol.byName.get('CSProtoSyncGrowupExcultivationAssistCharData').rsp
                f.protocol.encode = function (name, ...args) {
                    if (name === type) throw Error('normal ending codec failure')
                    return encode.call(this, name, ...args)
                }
                try {
                    assert.throws(() => f.dispatch(confirmation), /codec failure/)
                } finally {
                    f.protocol.encode = encode
                }
                assert.equal(f.hash(), before)
                assert.equal(f.state().acceptedCultTrials?.[receipt], undefined)
            }
            const accepted = f.dispatch(confirmation)
            assert(accepted.some((packet) => packet.id === 9617 && packet.seq === confirmation.seq))
            assert.equal(f.state().acceptedCultTrials[receipt], true)
            receipts.push(receipt)
            assert(receipts.every((key) => f.state().acceptedCultTrials[key] === true))
            const permanent = structuredClone(f.state().activities[60001].growupPermanent)
            const book = structuredClone(f.state().activities[60001].growup.end_data)
            f.dispatch(confirmation)
            assert.deepEqual(f.state().activities[60001].growupPermanent, permanent)
            assert.deepEqual(f.state().activities[60001].growup.end_data, book)
            if (phase < 3) assert.equal(Object.keys(permanent.endings).length, 0)
            else {
                assert.equal(Object.keys(permanent.endings).length, 1)
                assert.equal(permanent.endings[guid].ending_id, 101)
                assert.equal(permanent.endings[guid].source, 'trial-completion')
                assert(permanent.unlocked.includes(100))
                assert.equal(f.state().activities[60001].growup.cur_stage, 4)
                assert.deepEqual(
                    book.complete_end.map((ending) => ending.id),
                    [101],
                )
                assert(
                    accepted.some(
                        (packet) =>
                            packet.id === f.protocol.byName.get('CSProtoSyncGrowupExcultivationAssistCharData').id,
                    ),
                )
                finalRequest = confirmation
            }
            f.call('WorldPoint', { point_id: 0 })
            assert.equal(f.state().cultTrial, undefined)
            assert.equal(f.state().world.map_id, returnMap)
        }
        const saved = structuredClone(f.state().activities[60001])
        assert.equal(saved.growup.trails.length, 3)
        const nowMs = f.time()
        f.close()
        f = open(file, account, nowMs)
        const restored = f.state().activities[60001]
        assert.deepEqual(restored.growup.end_data, saved.growup.end_data)
        assert.deepEqual(restored.growup.trails, saved.growup.trails)
        assert.deepEqual(restored.growupPermanent, saved.growupPermanent)
        assert(receipts.every((key) => f.state().acceptedCultTrials[key] === true))
        f.dispatch(finalRequest)
        assert.deepEqual(f.state().activities[60001].growupPermanent, saved.growupPermanent)
        assert.equal(f.state().activities[60001].growup.end_data.complete_end.length, 1)
    } finally {
        f.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-cult-normal-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['state.sqlite', 'state.sqlite-journal'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
})
