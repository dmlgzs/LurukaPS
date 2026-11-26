import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables, seedPlayer, heroData } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { journeyModel } from '../src/journey.js'
import { journeySoulWearRule, journeySoulWearValue } from '../src/journey-soul-wear.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    tokens = [12235, 2, 1]
function bound() {
    const state = seedPlayer(tables, 1, 'soul-wear-current'),
        hero = state.player.heros_info.heros.find((row) => row.type === 1)
    state.player.heros_info.heros = [hero]
    hero.wguid = 1
    state.player.soulessence_infos.soulessences = [{ guid: 1, id: 10037, wear_hero: hero.guid }]
    return state
}

test('current soul-wear goals accept only the visible shape and real current permanent bidirectional bindings', () => {
    const model = journeyModel(tables)
    for (const id of [1010005, 4050109]) assert(model.byTarget.get(id).supported)
    assert(journeySoulWearRule(tokens))
    for (const rule of [
        [12235, 1, 1],
        [12235, 2, 2],
        [12235, 2, 1, 1],
    ]) {
        assert.equal(journeySoulWearRule(rule), false)
        assert.equal(journeySoulWearValue(tables, {}, rule), null)
    }
    const state = bound(),
        main = state.player.heros_info.heros[0]
    assert.equal(tables.find('hero', main.conf_id).favor, 0)
    assert.equal(journeySoulWearValue(tables, state, tokens), 1)
    const saved = structuredClone(state)
    state.player.soulessence_infos.soulessences[0].wear_hero = '0'
    assert.equal(journeySoulWearValue(tables, state, tokens), 0)
    for (const flag of ['trail', 'trial', 'is_trial', 'abyss']) {
        const temporary = structuredClone(saved)
        temporary.player.heros_info.heros[0][flag] = true
        assert.equal(journeySoulWearValue(tables, temporary, tokens), 0)
    }
    const foreign = structuredClone(saved)
    foreign.player.heros_info.heros = [heroData(main.conf_id, 2, 1)]
    foreign.player.heros_info.heros[0].wguid = 1
    foreign.player.soulessence_infos.soulessences[0].wear_hero = foreign.player.heros_info.heros[0].guid
    assert.equal(journeySoulWearValue(tables, foreign, tokens), 0)
    const legacy = structuredClone(saved)
    legacy.player.heros_info.heros = [heroData(104001, 1)]
    legacy.player.heros_info.heros[0].wguid = 1
    legacy.player.soulessence_infos.soulessences[0].wear_hero = legacy.player.heros_info.heros[0].guid
    assert.equal(journeySoulWearValue(tables, legacy, tokens), 0)
    const duplicate = structuredClone(saved)
    duplicate.player.heros_info.heros.push(structuredClone(main))
    assert.throws(
        () => journeySoulWearValue(tables, duplicate, tokens),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const unknown = structuredClone(saved)
    unknown.player.heros_info.heros[0].conf_id = 99999999
    assert.throws(() => journeySoulWearValue(tables, unknown, tokens))
    const oldTask = structuredClone(saved)
    oldTask.player.heros_info.heros[0].wguid = 0
    oldTask.taskRecords = [{ task_id: 106010, count: 1 }]
    assert.equal(journeySoulWearValue(tables, oldTask, tokens), 0)
    const stable = bound(),
        snapshot = structuredClone(stable)
    journeySoulWearValue(tables, stable, tokens)
    assert.deepEqual(stable, snapshot)
})

test('actual6046 wear, replay, unwear and reconnect preserve equipment assets and earned journey progress', () => {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const frame = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry)
        return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) }
    }
    const state = () => store.load(session.id).state
    try {
        game.dispatch(session, frame('EnterGame', { open_id: 'journey-wear-wire' }))
        store.transact(session.id, 0, (s) => {
            for (const hero of s.player.heros_info.heros) hero.wguid = 0
            for (const soul of s.player.soulessence_infos.soulessences) soul.wear_hero = '0'
            s.taskRecords = [{ task_id: 106010, count: 1 }]
            grantRewards(tables, s, [{ itemtype: 9, itemid: 10037, itemnum: 1 }])
        })
        assert.equal(journeySoulWearValue(tables, state(), tokens), 0)
        const hero = state().player.heros_info.heros.find((row) => row.type === 1),
            soul = state().player.soulessence_infos.soulessences.find((row) => row.id === 10037),
            request = frame('MoveSoulEssence', { hero_id: hero.guid, guid: soul.guid }),
            packets = game.dispatch(session, request),
            sync = protocol.byName.get('SCProtoJourneySync')
        assert(packets.some((packet) => packet.id === sync.id))
        assert.equal(journeySoulWearValue(tables, state(), tokens), 1)
        for (const id of [1010005, 4050109]) assert.equal(state().journey.targets[id].complete, true)
        const afterWear = state()
        game.dispatch(session, request)
        assert.deepEqual(state().player, afterWear.player)
        for (const id of [1010005, 4050109])
            assert.deepEqual(state().journey.targets[id], afterWear.journey.targets[id])
        game.dispatch(session, frame('MoveSoulEssence', { hero_id: hero.guid, guid: 0 }))
        assert.equal(journeySoulWearValue(tables, state(), tokens), 0)
        assert.equal(state().player.soulessence_infos.soulessences.find((row) => row.guid === soul.guid).wear_hero, '0')
        for (const id of [1010005, 4050109]) assert.equal(state().journey.targets[id].complete, true)
        const afterUnwear = state(),
            login = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(
            {},
            { id: login.id, seq: 1, payload: protocol.encode(login.req, { open_id: 'journey-wear-wire' }) },
        )
        assert.deepEqual(state().player.soulessence_infos, afterUnwear.player.soulessence_infos)
        for (const id of [1010005, 4050109])
            assert.deepEqual(state().journey.targets[id], afterUnwear.journey.targets[id])
        console.info(
            '6046 packet sequence:',
            packets.map((packet) => protocol.byId.get(packet.id)?.name ?? packet.id).join(', '),
        )
    } finally {
        store.close()
    }
})
