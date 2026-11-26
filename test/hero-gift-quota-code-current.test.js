import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('actual uncached6610 per-hero and account quota failures use current HeroGifNumFull without spending, favor, receipts or revision writes', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now, gmEnabled: true })
    const frame = (name, data) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0) }
    }
    const dispatch = (r) => {
        const out = game.dispatch(session, r),
            e = protocol.byId.get(r.id)
        return e.rsp ? protocol.decode(e.rsp, out.find((p) => p.id === r.id).payload) : undefined
    }
    const call = (name, data) => dispatch(frame(name, data)),
        state = () => store.load(session.id).state,
        gm = (s) => call('GMCommand', { command: Buffer.from(s).toString('base64') })
    try {
        call('EnterGame', { open_id: 'hero-gift-quota-native-code' })
        assert.equal(state().starterProfile.mode, 'normal')
        assert.equal(state().player.sbag_infos.items.length, 0)
        // Only the current UI's independently qualified story prerequisite.
        // The gift stock/counters/favor/receipts below come from real requests.
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = [{ task_id: 106010, count: 1 }]
        })
        const per = Number(tables.get('game').find((r) => r.title === 'HERO_FAVORABILITY_GIFT_NUM').value),
            total = Number(tables.get('game').find((r) => r.title === 'HERO_FAVORABILITY_ALL_GIFT_NUM').value),
            needed = Math.ceil(total / per) + 1
        const eligible = () =>
            state().player.heros_info.heros.filter((h) => !h.trail && tables.find('hero', h.conf_id)?.favor === 1)
        for (const hero of tables.get('hero').filter((r) => r.favor === 1)) {
            if (eligible().length >= needed) break
            if (!eligible().some((h) => h.conf_id === hero.id)) gm(`give 1 ${hero.id} 1`)
        }
        const targets = eligible().slice(0, needed),
            gift = tables.get('hero_favorability_gift').find((r) => tables.find('common_item', r.id)?.type === 110)
        assert.equal(targets.length, needed)
        gm(`item ${gift.id} ${total + per + 1}`)
        const request = (hero, num) =>
            frame('SendHeroGift', { heroId: hero.conf_id, item_id: gift.id, item_type: 110, num })
        const first = request(targets[0], per),
            paid = dispatch(first),
            saved = store.load(session.id)
        // A legitimate paid request replay is already committed, even at quota.
        assert.deepEqual(dispatch(first), paid)
        assert.deepEqual(store.load(session.id).state.player, saved.state.player)
        const overHero = store.load(session.id)
        assert.throws(
            () => dispatch(request(targets[0], 1)),
            (err) => {
                assert.equal(err.code, ErrorCode.HeroGifNumFull)
                return /Daily hero gift limit/.test(err.message)
            },
        )
        assert.deepEqual(store.load(session.id), overHero)
        let remaining = total - per
        for (const hero of targets.slice(1)) {
            if (!remaining) break
            const count = Math.min(remaining, per)
            dispatch(request(hero, count))
            remaining -= count
        }
        assert.equal(remaining, 0)
        assert.equal(state().player.basic_info.hero_gift_info.gift_num, total)
        const overAccount = store.load(session.id),
            fresh = targets.at(-1)
        assert.equal(state().player.heros_info.heros.find((h) => h.guid === fresh.guid).daily_gift_num ?? 0, 0)
        assert.throws(
            () => dispatch(request(fresh, 1)),
            (err) => {
                assert.equal(err.code, ErrorCode.HeroGifNumFull)
                return /Daily hero gift limit/.test(err.message)
            },
        )
        assert.deepEqual(store.load(session.id), overAccount)
        const tip = tables.find('errorCode', ErrorCode.HeroGifNumFull)
        assert.equal(tip.name, '赠礼已达上限')
        now += 86400
        dispatch(request(fresh, 1))
        assert.equal(state().player.basic_info.hero_gift_info.gift_num, 1)
        assert.equal(state().player.heros_info.heros.find((h) => h.guid === fresh.guid).daily_gift_num, 1)
    } finally {
        store.close()
    }
})

function integrityFixture(name, prime = true) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now, gmEnabled: true })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            out = game.dispatch(session, {
                id: e.id,
                seq: seq++,
                payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
            })
        return e.rsp ? protocol.decode(e.rsp, out.find((p) => p.id === e.id).payload) : undefined
    }
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn),
        gm = (s) => call('GMCommand', { command: Buffer.from(s).toString('base64') })
    call('EnterGame', { open_id: 'quota-integrity-' + name })
    edit((s) => {
        s.tasks = []
        s.taskRecords = [{ task_id: 106010, count: 1 }]
    })
    call('EnterHome', { creator_id: session.id })
    const config = tables
        .get('hero')
        .find(
            (r) =>
                r.favor === 1 && r.isUsable === 1 && !state().player.heros_info.heros.some((h) => h.conf_id === r.id),
        )
    gm(`give 1 ${config.id} 1`)
    const actor = () => state().player.heros_info.heros.find((h) => h.conf_id === config.id && !h.trail),
        gift = tables.get('hero_favorability_gift').find((r) => tables.find('common_item', r.id)?.type === 110)
    gm(`item ${gift.id} 100`)
    const send = () => call('SendHeroGift', { heroId: config.id, item_id: gift.id, item_type: 110, num: 1 })
    if (prime) send()
    return {
        tables,
        protocol,
        store,
        state,
        edit,
        actor,
        send,
        saved: () => store.load(session.id),
        advance: () => (now += 86400),
        close: () => store.close(),
    }
}
const failAtomic = (f, code) => {
    const before = f.saved()
    assert.throws(f.send, (err) => err.code === code)
    assert.deepEqual(f.saved(), before)
}

test('quota configuration must contain one successfully parsed current string Int32; missing, malformed or duplicate values never become full-quota10941', () => {
    const f = integrityFixture('config')
    try {
        const get = f.tables.get.bind(f.tables),
            rows = get('game')
        for (const title of ['HERO_FAVORABILITY_GIFT_NUM', 'HERO_FAVORABILITY_ALL_GIFT_NUM']) {
            const target = rows.find((r) => r.title === title)
            for (const view of [
                rows.filter((r) => r.title !== title),
                [...rows, { ...target }],
                ...[undefined, null, false, true, 0, 10, '', ' ', 'NaN', '1.5', '1e1', '-1', '2147483648'].map(
                    (value) => rows.map((r) => (r.title === title ? { ...r, value } : r)),
                ),
            ]) {
                f.tables.get = (name) => (name === 'game' ? view : get(name))
                try {
                    failAtomic(f, ErrorCode.GameConfig)
                } finally {
                    f.tables.get = get
                }
            }
        }
    } finally {
        f.close()
    }
})

test('damaged same-day UInt32 counters or containers are configuration errors and remain untouched even when a day reset is due', () => {
    const f = integrityFixture('saved')
    try {
        const original = structuredClone(f.state().player.basic_info.hero_gift_info),
            heroCount = f.actor().daily_gift_num
        for (const field of ['daily', 'account'])
            for (const value of [null, -1, 0.5, '0', false, 4294967296]) {
                f.edit((s) => {
                    if (field === 'daily')
                        s.player.heros_info.heros.find((h) => h.guid === f.actor().guid).daily_gift_num = value
                    else s.player.basic_info.hero_gift_info.gift_num = value
                })
                failAtomic(f, ErrorCode.GameConfig)
                f.edit((s) => {
                    s.player.heros_info.heros.find((h) => h.guid === f.actor().guid).daily_gift_num = heroCount
                    s.player.basic_info.hero_gift_info = structuredClone(original)
                })
            }
        for (const value of [null, [], 0, 'bad', undefined]) {
            f.edit((s) => {
                s.player.basic_info.hero_gift_info = value
            })
            failAtomic(f, ErrorCode.GameConfig)
            f.edit((s) => {
                s.player.basic_info.hero_gift_info = structuredClone(original)
            })
        }
        f.edit((s) => {
            s.player.heros_info.heros.find((h) => h.guid === f.actor().guid).daily_gift_num = -1
        })
        f.advance()
        failAtomic(f, ErrorCode.GameConfig)
        f.edit((s) => {
            s.player.heros_info.heros.find((h) => h.guid === f.actor().guid).daily_gift_num = heroCount
        })
        f.send()
        assert.equal(f.actor().daily_gift_num, 1)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
    } finally {
        f.close()
    }
})

test('explicit zero quotas and omitted optional UInt32 zero scalars keep their distinct valid semantics without NaN or free extra quota', () => {
    const f = integrityFixture('zero', false)
    try {
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 0)
        assert.equal(f.actor().daily_gift_num ?? 0, 0)
        // Only unspent default-zero scalars are omitted, matching proto2.
        f.edit((s) => {
            delete s.player.basic_info.hero_gift_info.gift_num
            delete s.player.heros_info.heros.find((h) => h.guid === f.actor().guid).daily_gift_num
        })
        f.send()
        assert.equal(f.actor().daily_gift_num, 1)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
        const get = f.tables.get.bind(f.tables),
            rows = get('game')
        for (const title of ['HERO_FAVORABILITY_GIFT_NUM', 'HERO_FAVORABILITY_ALL_GIFT_NUM']) {
            f.tables.get = (name) =>
                name === 'game' ? rows.map((r) => (r.title === title ? { ...r, value: '0' } : r)) : get(name)
            try {
                failAtomic(f, ErrorCode.HeroGifNumFull)
            } finally {
                f.tables.get = get
            }
        }
        f.advance()
        f.send()
        assert.equal(f.actor().daily_gift_num, 1)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
    } finally {
        f.close()
    }
})

test('a missing optional gift-info message is refused on an already initialized day but the existing next-day writer may initialize it', () => {
    const f = integrityFixture('missing-message', false)
    try {
        f.edit((s) => {
            delete s.player.basic_info.hero_gift_info
        })
        failAtomic(f, ErrorCode.GameConfig)
        f.advance()
        f.send()
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
        assert.equal(f.actor().daily_gift_num, 1)
    } finally {
        f.close()
    }
})
