import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { soulLevelLimit } from '../src/soul-level.js'
import { ErrorCode } from '../src/error-codes.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroModules } from '../src/battle.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    config = tables.find('soulessence', 10044)
const curve = tables.get('soulessence_level').filter((row) => row.rarity === config.rarity)
const material = Number(
    String(tables.get('game').find((row) => row.title === 'SOULESSENCE_EXP_ITEM').value).split('|')[0],
)
const exp = Number(tables.find('common_item', material).useFunction),
    ratio = Number(tables.get('game').find((row) => row.title === 'WEAPON_LEVELUP_GOLD').value) / 10000
const cost = (quantity) => Math.floor(exp * ratio) * quantity
function fixture(name) {
    const store = new Store(':memory:'),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: name })
    const grant = (commands) =>
        call('GMCommands', { cmds: commands.map((command) => ({ command: Buffer.from(command).toString('base64') })) })
    grant(['give 9 10044 1', 'give 1 107002 1'])
    const state = () => store.load(session.id).state,
        guid = state().player.soulessence_infos.soulessences.find((item) => item.id === config.id).guid
    return {
        store,
        protocol,
        session,
        call,
        grant,
        state,
        guid,
        soul: () => state().player.soulessence_infos.soulessences.find((item) => item.guid === guid),
        edit: (fn) => store.transact(session.id, 0, fn),
    }
}
function unchanged(f, fn, code) {
    const old = f.store.load(f.session.id)
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.store.load(f.session.id), old)
}

test('every actual soul has seven current level bands and the terminal100 cap without a6049 request', () => {
    assert.equal(tables.get('soulessence').length, 77, 'current level-band matrix covers every target template')
    let checked = 0
    for (const row of tables.get('soulessence')) {
        const ranks = tables
            .get('soulessence_rank')
            .filter((rank) => rank.relatedId === row.id)
            .sort((a, b) => a.rank - b.rank)
        assert.deepEqual(
            ranks.map((rank) => rank.rank),
            [1, 2, 3, 4, 5, 6, 7],
        )
        const state = seedPlayer(tables, 1, 'soul-current-bands')
        for (let index = 0; index < ranks.length; index++) {
            const level = index === 0 ? 1 : Number(ranks[index - 1].condition.split('|')[1])
            state.player.basic_info.lv = level
            const item = { id: row.id, rank: 1 }
            assert.equal(soulLevelLimit(tables, state, item).cap, ranks[index].rankLevelLimit)
            assert.equal(item.rank, 1)
        }
        assert.equal(ranks.at(-1).rankLevelLimit, 100)
        checked++
    }
    assert.equal(checked, tables.get('soulessence').length)
})

test('player gate replaces6049; unlocking the next band preserves XP/equipment before real6047 pays for growth', () => {
    const name = 'soul-current-equipped-band',
        f = fixture(name)
    try {
        f.edit((state) => {
            Object.assign(
                state.player.soulessence_infos.soulessences.find((item) => item.guid === f.guid),
                { lv: 30, exp: 500 },
            )
            state.player.basic_info.lv = 19
        })
        const hero = f.state().player.heros_info.heros.find((hero) => hero.conf_id === 107002)
        f.call('MoveSoulEssence', { hero_id: hero.guid, guid: f.guid })
        const quantity = Math.ceil(
            (curve.find((row) => row.lv === 31).exp_all - curve.find((row) => row.lv === 30).exp_all) / exp,
        )
        f.grant([`give 3 ${material} ${quantity}`, `give 10 2 ${cost(quantity) + 19}`])
        const request = { guid: f.guid, cost_items: [{ id: material, num: quantity }] }
        unchanged(f, () => f.call('ComposeSoulEssence', request), ErrorCode.SoulEssenceNoConfig)
        const oldSoul = structuredClone(f.soul()),
            gold = f.state().player.basic_info.gold,
            attrs = heroModules(tables, f.state(), hero)
        f.edit((state) => {
            state.player.basic_info.lv = 20
        })
        assert.equal(soulLevelLimit(tables, f.state(), f.soul()).cap, 50)
        assert.deepEqual(f.soul(), oldSoul)
        assert.equal(f.state().player.basic_info.gold, gold, 'band unlock has no retired-rank charge')
        assert.deepEqual(heroModules(tables, f.state(), hero), attrs, 'band unlock alone does not grant stats or heal')
        assert.equal(f.protocol.byName.has('CSProtoRankUpSoulEssence'), false)
        const packets = f.call('ComposeSoulEssence', request),
            ack = packets.findIndex((packet) => packet.id === 6047)
        assert(
            ack >= 0 &&
                packets.slice(0, ack).some((packet) => packet.id === f.protocol.byName.get('CSProtoSyncPlayerData').id),
        )
        assert(f.soul().lv > 30 && f.soul().lv <= 50)
        assert.equal(f.soul().rank, oldSoul.rank)
        assert.equal(f.soul().guid, oldSoul.guid)
        assert.equal(f.soul().wear_hero, hero.guid)
        assert.equal(f.state().player.basic_info.gold, gold - cost(quantity))
        assert.equal(
            curve.find((row) => row.lv === f.soul().lv).exp_all + f.soul().exp,
            curve.find((row) => row.lv === 30).exp_all + 500 + exp * quantity,
        )
        const saved = structuredClone(f.soul())
        f.call('EnterGame', { open_id: name }, {})
        assert.deepEqual(f.soul(), saved)
    } finally {
        f.store.close()
    }
})

test('current6047 material entries aggregate and failed material or gold settlement rolls back the whole request', () => {
    const f = fixture('soul-current-material-costs')
    try {
        const request = {
            guid: f.guid,
            cost_items: [
                { id: material, num: 2 },
                { id: material, num: 3 },
            ],
        }
        unchanged(f, () => f.call('ComposeSoulEssence', request), ErrorCode.ItemNotEnough)
        f.grant([`give 10 2 ${cost(5)}`])
        unchanged(f, () => f.call('ComposeSoulEssence', request), ErrorCode.ItemNotEnough)
        f.grant([`give 3 ${material} 5`])
        const old = structuredClone(f.soul())
        f.call('ComposeSoulEssence', request)
        assert.equal(f.state().player.basic_info.gold, 0)
        assert.equal(f.state().player.sbag_infos.items.find((item) => item.itemid === material).itemnum, 0)
        assert.equal(f.soul().rank, old.rank)
        assert.equal(curve.find((row) => row.lv === f.soul().lv).exp_all + f.soul().exp, exp * 5)
    } finally {
        f.store.close()
    }
})

test('current ownership/preview and level limits reject atomically while legitimate pre-cap strengthening still works', () => {
    const f = fixture('soul-current-band-errors')
    try {
        unchanged(
            f,
            () => f.call('ComposeSoulEssence', { guid: 0xffffffff, cost_items: [{ id: material, num: 1 }] }),
            ErrorCode.SoulEssenceNotExist,
        )
        // getPreviewSoulEssenceItem0600f665 does not set guid or insert it in the
        // owned map. Its zero GUID is not a consumable saved/zombie-owned instance.
        unchanged(
            f,
            () => f.call('ComposeSoulEssence', { guid: 0, cost_items: [{ id: material, num: 1 }] }),
            ErrorCode.SoulEssenceNotExist,
        )
        f.edit((state) => {
            Object.assign(
                state.player.soulessence_infos.soulessences.find((item) => item.guid === f.guid),
                { lv: 29, exp: 0 },
            )
            state.player.basic_info.lv = 19
        })
        const quantity = Math.ceil(
            (curve.find((row) => row.lv === 30).exp_all - curve.find((row) => row.lv === 29).exp_all) / exp,
        )
        f.grant([`give 3 ${material} ${quantity + 1}`, `give 10 2 ${cost(quantity + 1)}`])
        f.call('ComposeSoulEssence', { guid: f.guid, cost_items: [{ id: material, num: quantity }] })
        assert.equal(f.soul().lv, 30)
        assert.equal(f.soul().rank, 1)
        unchanged(
            f,
            () => f.call('ComposeSoulEssence', { guid: f.guid, cost_items: [{ id: material, num: 1 }] }),
            ErrorCode.SoulEssenceNoConfig,
        )
        f.edit((state) => {
            Object.assign(
                state.player.soulessence_infos.soulessences.find((item) => item.guid === f.guid),
                { lv: 100, rank: 7, exp: 0 },
            )
            state.player.basic_info.lv = 70
        })
        assert.equal(soulLevelLimit(tables, f.state(), f.soul()).cap, 100)
        unchanged(
            f,
            () => f.call('ComposeSoulEssence', { guid: f.guid, cost_items: [{ id: material, num: 1 }] }),
            ErrorCode.SoulEssenceNoConfig,
        )
    } finally {
        f.store.close()
    }
})
