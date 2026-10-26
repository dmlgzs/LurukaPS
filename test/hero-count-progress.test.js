import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer, heroData } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { mainHeroConfigId } from '../src/main-hero.js'
import { achievementCatalogue } from '../src/achievements.js'
import { heroCountProgressRule, heroCountProgressValue } from '../src/hero-count-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
const avatars = new Set([mainHeroConfigId(tables, 1), mainHeroConfigId(tables, 2)])
const companions = tables.get('hero').filter((row) => row.isUsable === 1 && !avatars.has(row.id))
const conditions = () => {
    const model = achievementCatalogue(tables)
    return model.rows.filter((row) => model.rules.get(row.id).tokens?.[0] === 12036).sort((a, b) => a.param - b.param)
}
const value = (state) => heroCountProgressValue(tables, state, [12036, 0, 1])
const error = (code) => (e) => e.code === code

function fixture(name, filename = ':memory:', initialCompanions = 3) {
    const store = new Store(filename)
    store.login(name, (id, openId) => {
        const state = seedPlayer(tables, id, openId)
        const keep = new Set([...avatars, ...companions.slice(0, initialCompanions).map((row) => row.id)])
        state.player.heros_info.heros = state.player.heros_info.heros.filter((hero) => keep.has(hero.conf_id))
        state.tasks = []
        state.player.basic_info.lv = 30
        return state
    })
    const protocol = new Protocol(cfg.base),
        session = {},
        now = 1800000000
    const game = new Game(protocol, store, tables, { clock: () => now })
    let sequence = 1,
        nextMail = 9007199254740993n
    const call = (name, request = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: sequence++,
            payload: row.req ? protocol.encode(row.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    const mail = (heroIds) => {
        const guid = (nextMail++).toString()
        edit((s) => {
            s.mail ??= []
            s.mail.push({
                guid,
                createtm: now,
                effecttm: 0,
                fetch: false,
                read: false,
                collect: false,
                reward: { rewards: heroIds.map((itemid) => ({ itemtype: 1, itemid, itemnum: 1 })) },
            })
        })
        return guid
    }
    return {
        store,
        protocol,
        session,
        game,
        call,
        edit,
        state,
        mail,
        receive: (guid) => call('FetchMail', { u64: guid }),
        entry: (id) => state().achievements?.entries?.[id],
    }
}

test('all three current HaveHero targets compile; unproved selectors stay closed and the two avatars count once', () => {
    const rows = conditions(),
        model = achievementCatalogue(tables)
    assert.deepEqual(
        rows.map((row) => row.param),
        [5, 10, 20],
    )
    assert(rows.every((row) => model.rules.get(row.id).supported))
    assert.equal(model.rows.filter((row) => model.rules.get(row.id).supported).length, 123)
    assert.equal(
        rows.reduce((sum, row) => sum + row.achPoint, 0),
        17,
    )
    for (const tokens of [null, {}, [12036], [12036, 1, 5], [12036, 0, 0], [12036, 0, 5, 0]])
        assert.equal(heroCountProgressRule(tables, tokens), false)
    const s = seedPlayer(tables, 42, 'hero-count-unit')
    s.player.heros_info.heros = [...avatars].map((id) => heroData(id, 42))
    assert.equal(value(s), 1)
    s.player.heros_info.heros.pop()
    assert.equal(value(s), 1)
    s.player.heros_info.heros = []
    assert.equal(value(s), 0)
    s.player.heros_info.heros = [heroData(companions[0].id, 42)]
    assert.equal(value(s), 1)
    const damagedAvatar = {
        get: (name) =>
            name === 'game' ? tables.get(name).filter((row) => row.title !== 'AVATAR_HERO_ID_MALE') : tables.get(name),
    }
    assert.throws(() => heroCountProgressRule(damagedAvatar, [12036, 0, 5]), error(ErrorCode.GameConfig))
})

test('permanent normal owner identities exclude trial copies, foreign owners and unavailable configs without favor filtering', () => {
    const base = seedPlayer(tables, 42, 'hero-count-identities')
    base.player.heros_info.heros = [...avatars].map((id) => heroData(id, 42))
    const extras = [
        { ...heroData(companions[0].id, 42), trail: true },
        heroData(companions[1].id, 99),
        { ...heroData(companions[2].id, 42), guid: ((7n << 56n) | 123n).toString() },
    ]
    base.player.heros_info.heros.push(...extras)
    assert.equal(value(base), 1)
    const unavailable = tables.get('hero').find((row) => row.isUsable === 0)
    assert(unavailable)
    base.player.heros_info.heros.push(heroData(unavailable.id, 42))
    assert.equal(value(base), 1) // Explicit current producer boundary, not a client filter claim.
    const temporary = heroData(companions[3].id, 42)
    base.player.heros_info.heros.push(temporary)
    base.trialGroup = { heroes: [temporary] }
    assert.equal(value(base), 1)
    for (const guid of ['0', '18446744073709551616', Number.MAX_SAFE_INTEGER + 1]) {
        const bad = structuredClone(base)
        bad.player.heros_info.heros[0].guid = guid
        assert.throws(() => value(bad), error(ErrorCode.GameConfig))
    }
    const duplicate = structuredClone(base)
    duplicate.player.heros_info.heros.push({ ...duplicate.player.heros_info.heros[0] })
    assert.throws(() => value(duplicate), error(ErrorCode.GameConfig))
    const legacy = structuredClone(base)
    legacy.player.heros_info.heros = [{ ...heroData(companions[0].id, 42), guid: '01' }]
    assert.equal(value(legacy), 1)
    legacy.player.heros_info.heros.push({ ...heroData(companions[1].id, 42), guid: '1' })
    assert.throws(() => value(legacy), error(ErrorCode.GameConfig))
})

test('actual server-owned mail hero rewards reach5/10/20 and acknowledge all three achievement claims only once', () => {
    const f = fixture('hero-count-real-mail')
    try {
        assert.equal(value(f.state()), 4)
        const rows = conditions()
        for (const row of rows) {
            const previous = value(f.state())
            assert.throws(() => f.call('AchievementReward', { u32: row.id }), error(ErrorCode.AchievementIsRunning))
            const needed = companions.slice(previous - 1, row.param - 1).map((hero) => hero.id)
            assert.equal(needed.length, row.param - previous)
            const id = f.mail(needed),
                packets = f.receive(id)
            assert.equal(value(f.state()), row.param)
            assert.equal(f.entry(row.id).value, row.param)
            assert(f.entry(row.id).finishTime > 0)
            const sync = packets.find((p) => p.id === 9900)
            assert(sync)
            assert(f.protocol.decode('SCAchievementSync', sync.payload).achievements.some((a) => a.id === row.id))
            f.call('AchievementReward', { u32: row.id })
            assert.equal(f.entry(row.id).claimed, true)
            f.call('AchievementReward', { u32: row.id })
            assert.equal(f.entry(row.id).claimed, true)
        }
        const before = value(f.state())
        f.receive(f.mail([companions[0].id])) // Legitimate duplicate hero reward must not count twice.
        assert.equal(value(f.state()), before)
    } finally {
        f.store.close()
    }
})

test('hero reward and newly observed threshold roll back together on actual achievement encoding and SQL failure', () => {
    const f = fixture('hero-count-rollback')
    try {
        const id = f.mail([companions[3].id]),
            before = f.state()
        const token = f.store.readCacheToken(f.session.id),
            pending = f.store.pending.get(f.session.id)
        const oldPacket = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoAchievementSync') throw Error('hero-count-codec')
            return oldPacket.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.receive(id), /hero-count-codec/)
        } finally {
            f.game.packet = oldPacket
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        assert.equal(f.store.pending.get(f.session.id), pending)
        f.store.db.exec(
            `CREATE TEMP TRIGGER hero_count_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'hero-count-SQL'); END`,
        )
        try {
            assert.throws(() => f.receive(id), /hero-count-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER hero_count_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        f.receive(id)
        assert.equal(value(f.state()), 5)
    } finally {
        f.store.close()
    }
})

test('SQLite reopen preserves owned-count claims without sharing another account roster or copying trial actors', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-count-'))
    const filename = path.join(directory, 'count.sqlite')
    let f = fixture('hero-count-reopen', filename)
    try {
        f.receive(f.mail([companions[3].id]))
        const row = conditions()[0]
        f.call('AchievementReward', { u32: row.id })
        const heroIds = f.state().player.heros_info.heros.map((h) => h.guid)
        f.store.close()
        f = fixture('hero-count-reopen', filename)
        assert.deepEqual(
            f.state().player.heros_info.heros.map((h) => h.guid),
            heroIds,
        )
        assert.equal(value(f.state()), 5)
        assert.equal(f.entry(row.id).claimed, true)
        const other = fixture('hero-count-other', filename, 1)
        try {
            assert.equal(value(other.state()), 2)
            assert(!other.entry(row.id)?.claimed)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('hero-count-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('unfinished imported values are reobserved while an equal full value gains its terminal time only with real ownership', () => {
    const f = fixture('hero-count-legacy-progress')
    const row = conditions()[0]
    try {
        f.edit((s) => {
            s.achievements.entries[row.id] = { value: row.param, finishTime: 0, claimed: false }
        })
        f.call('ActivityGet')
        assert.equal(f.entry(row.id).value, 4)
        assert.equal(f.entry(row.id).finishTime, 0)
        const mail = f.mail([companions[3].id])
        f.edit((s) => {
            s.achievements.entries[row.id] = { value: row.param, finishTime: 0, claimed: false }
        })
        f.receive(mail)
        assert.equal(value(f.state()), 5)
        assert.equal(f.entry(row.id).value, 5)
        assert(f.entry(row.id).finishTime > 0)
        for (const broken of [
            { value: 4, finishTime: 1799999990, claimed: false },
            { value: 5, finishTime: 0, claimed: true },
        ]) {
            f.edit((s) => {
                s.achievements.entries[row.id] = broken
            })
            const before = f.state()
            assert.throws(() => f.call('AchievementReward', { u32: row.id }), error(ErrorCode.GameConfig))
            assert.deepEqual(f.state(), before)
        }
        // Explicit imported terminal fixture; preserving it does not grant an actor.
        const terminal = { value: 5, finishTime: 1799999990, claimed: true }
        f.edit((s) => {
            s.achievements.entries[row.id] = terminal
            s.player.heros_info.heros = s.player.heros_info.heros.filter((hero) => hero.conf_id !== companions[3].id)
        })
        f.call('ActivityGet')
        assert.equal(value(f.state()), 4)
        assert.deepEqual(f.entry(row.id), terminal)
    } finally {
        f.store.close()
    }
})
