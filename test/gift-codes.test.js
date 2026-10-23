import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { GiftCodeCatalog, GiftCodeStatus } from '../src/gift-codes.js'
import { ErrorCode } from '../src/error-codes.js'
import defaults from '../configs/gift-codes.json' with { type: 'json' }
import { validateRewardDefinitions } from '../src/rewards.js'
import { appearanceCatalog } from '../src/appearance.js'
import { validateRewardTotals } from '../src/reward-definitions.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
const initial = 1800000000
function promotion(fields = {}) {
    return {
        id: 'test-promotion',
        code: 'TEST-ONLY',
        starts_at: initial - 1,
        ends_at: initial + 100,
        minimum_level: 1,
        mail: { sender: '本地测试', title: '兑换邮件', content: '测试附件内容', duration: 60 },
        rewards: [
            { itemtype: 3, itemid: 400000, itemnum: 4 },
            { itemtype: 10, itemid: 2, itemnum: 9 },
        ],
        ...fields,
    }
}
function source(rows = [promotion()]) {
    return { schema_version: 1, mode: 'local-configured-mail', codes: rows }
}
function fixture({ filename = ':memory:', openId = 'gift-codes', config = source() } = {}) {
    const store = new Store(filename)
    let clock = initial,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => clock, giftCodeConfig: config }),
        session = {}
    const call = (name, data = {}, header = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data), ...header })
    }
    call('EnterGame', { open_id: openId })
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        time: (value) => {
            clock = value
        },
        redeem: (code = 'TEST-ONLY', header) => call('ExchangeGiftCode', { code }, header),
        status: (packets) =>
            protocol.decode('cs.SCExchangeGiftCode', packets.find((p) => p.id === 6134).payload).status_code,
    }
}
const error = (code) => (e) => {
    assert.equal(e.code, code)
    return true
}
function snapshot(f) {
    return {
        players: f.store.db.prepare('SELECT * FROM players').all(),
        logs: f.store.db.prepare('SELECT * FROM request_log').all(),
        sequences: f.store.db.prepare('SELECT * FROM sequences').all(),
        pending: structuredClone([...f.store.pending]),
    }
}
const bag = (state) =>
    state.player.sbag_infos.items.filter((r) => r.itemid === 400000).reduce((n, r) => n + r.itemnum, 0)
test('default LOCAL code pool is empty and6131 has no response contract', () => {
    assert.deepEqual(defaults.codes, [])
    assert.equal(protocol.byId.get(6131).rsp, undefined)
    const f = fixture({ config: defaults })
    try {
        const packets = f.redeem()
        assert.equal(f.status(packets), GiftCodeStatus.Unknown)
        assert.equal(packets.filter((p) => p.id === 6131).length, 0)
        assert.equal(f.state().mail.length, 0)
    } finally {
        f.store.close()
    }
})
test('configured redemption creates UTF8/base64 attachment mail then6124 and6134 without granting bag rewards', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = f.redeem(),
            mail = f.state().mail[0]
        assert.equal(f.status(packets), 0)
        assert.equal(
            packets.some((p) => p.id === 6131),
            false,
        )
        assert.ok(packets.findIndex((p) => p.id === 6124) < packets.findIndex((p) => p.id === 6134))
        const wire = protocol.decode('cs.SCMailSync', packets.find((p) => p.id === 6124).payload).mails[0]
        assert.equal(Buffer.from(wire.title, 'base64').toString('utf8'), '兑换邮件')
        assert.equal(Buffer.from(wire.content, 'base64').toString('utf8'), '测试附件内容')
        assert.equal(Buffer.from(wire.sender_id, 'base64').toString('utf8'), '本地测试')
        assert.equal(wire.guid, mail.guid)
        assert.ok(BigInt(mail.guid) > BigInt(Number.MAX_SAFE_INTEGER))
        assert.equal(mail.effecttm, 60)
        assert.equal(mail.createtm, initial)
        assert.equal(bag(f.state()), bag(before))
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold)
        assert.equal(f.state().giftCodeClaims.by_id['test-promotion'].mail_guid, mail.guid)
        f.call('FetchMail', { u64: mail.guid })
        assert.equal(bag(f.state()), bag(before) + 4)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 9)
    } finally {
        f.store.close()
    }
})
test('fresh client status mapping covers unknown, expired, not-yet-open, level lock and already used', () => {
    for (const [row, code, status] of [
        [promotion(), 'test-only', 4],
        [promotion(), ' TEST-ONLY', 4],
        [promotion({ ends_at: initial }), 'TEST-ONLY', 1],
        [promotion({ starts_at: initial + 1 }), 'TEST-ONLY', 2],
        [promotion({ minimum_level: 999 }), 'TEST-ONLY', 2],
    ]) {
        const f = fixture({ config: source([row]) })
        try {
            assert.equal(f.status(f.redeem(code)), status)
            assert.equal(f.state().mail.length, 0)
            assert.equal(f.state().giftCodeClaims, undefined)
        } finally {
            f.store.close()
        }
    }
    const f = fixture()
    try {
        assert.equal(f.status(f.redeem()), 0)
        f.time(initial + 101)
        assert.equal(f.status(f.redeem()), 3)
        assert.equal(f.state().mail.length, 1)
    } finally {
        f.store.close()
    }
})
test('same transport sequence, new sequence and deleted mail do not create another redemption', () => {
    const f = fixture()
    try {
        assert.equal(f.status(f.redeem('TEST-ONLY', { seq: 77 })), 0)
        const guid = f.state().mail[0].guid
        assert.equal(f.status(f.redeem('TEST-ONLY', { seq: 77 })), 3)
        assert.equal(f.status(f.redeem()), 3)
        assert.equal(f.state().mail.length, 1)
        f.call('FetchMail', { u64: guid })
        f.call('DelMail', { u64: guid })
        assert.equal(f.state().mail.length, 0)
        assert.equal(f.status(f.redeem()), 3)
        assert.equal(f.state().mail.length, 0)
    } finally {
        f.store.close()
    }
})
test('accounts redeem independently and allocator creates distinct complete uint64 mail identities', () => {
    const f = fixture(),
        peer = {},
        login = protocol.byName.get('CSProtoEnterGame'),
        redeem = protocol.byId.get(6131)
    try {
        assert.equal(f.status(f.redeem()), 0)
        f.game.dispatch(peer, { id: login.id, seq: 1, payload: protocol.encode(login.req, { open_id: 'gift-peer' }) })
        const packets = f.game.dispatch(peer, {
            id: redeem.id,
            seq: 2,
            payload: protocol.encode(redeem.req, { code: 'TEST-ONLY' }),
        })
        assert.equal(f.status(packets), 0)
        const other = f.store.load(peer.id).state
        assert.notEqual(other.mail[0].guid, f.state().mail[0].guid)
        assert.equal(Object.keys(other.giftCodeClaims.by_id).length, 1)
        assert.equal(f.state().mail.length, 1)
    } finally {
        f.store.close()
    }
})
test('code-pool shape, duplicate IDs/codes and invalid attachments reject as configuration errors', () => {
    for (const config of [
        source([promotion(), promotion()]),
        source([promotion(), promotion({ id: 'different' })]),
        source([promotion({ code: 'x'.repeat(21) })]),
        source([promotion({ rewards: [] })]),
        source([promotion({ rewards: [{ itemtype: 3, itemid: 400000, itemnum: 0 }] })]),
        source([promotion({ ends_at: initial - 2 })]),
        source([promotion({ mail: { ...promotion().mail, duration: -1 } })]),
        { ...source(), wrongField: true },
    ])
        assert.throws(() => new GiftCodeCatalog(config), error(ErrorCode.GameConfig))
})
test('pure shared definition check covers supported typed catalogs without a player or inventory', () => {
    const catalog = appearanceCatalog(tables),
        entries = [
            [1, tables.get('hero').find((r) => r.isUsable === 1).id],
            [3, 400000],
            [5, tables.get('pet').find((r) => tables.find('template_value', r.id)).id],
            [9, tables.get('soulessence')[0].id],
            [13, tables.get('home_building')[0].id],
            [17, tables.get('player_title').find((r) => [1, 2].includes(r.type)).id],
            [20, tables.get('task_item')[0].id],
            [25, tables.get('mount_saddle')[0].id],
            [26, tables.get('playercard_dress')[0].id],
            [28, tables.get('library_readings')[0].id],
            [37, tables.get('pet_skin').find((r) => tables.find('pet', r.kiboId)).id],
            [40, tables.get('home_dorm_item')[0].id],
            [29, tables.get('reputation_level')[0].reputationId],
            [33, tables.get('accessory_customed')[0].id],
            [34, catalog.clothes.keys().next().value],
            [39, catalog.skins.keys().next().value],
            [10, 2],
            [14, tables.get('pet_egg')[0].id],
            [30, tables.get('pet_customized')[0].id],
        ]
    for (const [itemtype, itemid] of entries)
        assert.doesNotThrow(
            () => validateRewardDefinitions(tables, [{ itemtype, itemid, itemnum: 1 }]),
            `type ${itemtype}`,
        )
    for (const [itemtype, itemid] of [
        [999, 1],
        [3, 0xffffffff],
        [10, 4],
        [10, 14],
        [10, 50],
        [14, 0xffffffff],
        [30, 0xffffffff],
    ])
        assert.throws(
            () => validateRewardDefinitions(tables, [{ itemtype, itemid, itemnum: 1 }]),
            error(ErrorCode.GameConfig),
        )
})
test('bad attachment definitions reject before allocator and cannot leave unclaimable success mail', () => {
    const f = fixture({ config: source([promotion({ rewards: [{ itemtype: 3, itemid: 0xffffffff, itemnum: 1 }] })]) })
    try {
        const before = snapshot(f)
        assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.store.close()
    }
})
test('static impossible quantities and opaque allocator exhaustion fail without success or mutation', () => {
    const pet = tables.get('pet').find((r) => tables.find('template_value', r.id)).id,
        egg = tables.get('pet_egg')[0].id,
        saddle = tables.get('mount_saddle')[0].id
    for (const reward of [
        { itemtype: 5, itemid: pet, itemnum: 0xffffffff },
        { itemtype: 14, itemid: egg, itemnum: 0xffffffff },
        { itemtype: 25, itemid: saddle, itemnum: 2 },
    ])
        assert.throws(() => validateRewardDefinitions(tables, [reward]), error(ErrorCode.GameConfig))
    const f = fixture()
    try {
        f.store.db.prepare('INSERT INTO sequences(name,value) VALUES(?,?)').run('gift-code-mail', 0xffffffff)
        const before = snapshot(f)
        assert.throws(() => f.redeem(), /Sequence exhausted/)
        assert.deepEqual(snapshot(f), before)
    } finally {
        f.store.close()
    }
    const overflow = fixture({ config: source([promotion({ mail: { ...promotion().mail, duration: 0xffffffff } })]) })
    try {
        const before = snapshot(overflow)
        assert.throws(() => overflow.redeem(), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(overflow), before)
    } finally {
        overflow.store.close()
    }
})
test('egg and customized-pet mail share pure constructor definitions and grant only on6121', () => {
    for (const [itemtype, itemid] of [
        [14, tables.get('pet_egg')[0].id],
        [30, tables.get('pet_customized')[0].id],
    ]) {
        const f = fixture({ config: source([promotion({ rewards: [{ itemtype, itemid, itemnum: 1 }] })]) })
        try {
            const before = f.state(),
                eggs = (before.petEggs ?? []).length,
                pets = before.pets.length
            assert.equal(f.status(f.redeem()), 0)
            assert.equal((f.state().petEggs ?? []).length, eggs)
            assert.equal(f.state().pets.length, pets)
            const guid = f.state().mail[0].guid
            f.call('FetchMail', { u64: guid })
            assert.equal(f.state().mail[0].fetch, true)
            if (itemtype === 14) assert.equal(f.state().petEggs.length, eggs + 1)
            else {
                assert.equal(f.state().pets.length, pets + 1)
                assert.equal(f.state().pets.at(-1).customized_id, itemid)
            }
        } finally {
            f.store.close()
        }
    }
})
test('full equipment bag does not prevent redemption; capacity remains an atomic6121 claim check', () => {
    const equipment = tables.get('soulessence')[0].id,
        f = fixture({ config: source([promotion({ rewards: [{ itemtype: 9, itemid: equipment, itemnum: 1 }] })]) })
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences = Array.from({ length: 10000 }, (_, i) => ({
                guid: i + 1,
                id: equipment,
                lv: 1,
                rank: 1,
                advance: 1,
                exp: 0,
                lock: true,
                wear_hero: '0',
            }))
        })
        assert.equal(f.status(f.redeem()), 0)
        const guid = f.state().mail[0].guid
        assert.throws(() => f.call('FetchMail', { u64: guid }), /Equipment bag limit/)
        assert.equal(f.state().mail[0].fetch, false)
        assert.equal(f.state().player.soulessence_infos.soulessences.length, 10000)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences.pop()
        })
        f.call('FetchMail', { u64: guid })
        assert.equal(f.state().mail[0].fetch, true)
    } finally {
        f.store.close()
    }
})
test('saved receipt or mail identity corruption never reports success or writes a second mail', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.giftCodeClaims = { schema_version: 1, by_id: { broken: { id: 'wrong' } } }
        })
        const before = snapshot(f)
        assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(f), before)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.giftCodeClaims
            s.mail = [{ guid: String(0x8000000000000001n) }]
        })
        const collide = snapshot(f)
        assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(f), collide)
    } finally {
        f.store.close()
    }
})
test('6124 and6134 codec failures roll back mail, receipt, authoritative allocator and saved state', () => {
    const f = fixture(),
        encode = protocol.encode
    try {
        for (const failed of ['cs.SCMailSync', 'cs.SCExchangeGiftCode']) {
            const before = snapshot(f)
            protocol.encode = function (type, data) {
                if (type === failed) throw Error('gift-codec-test')
                return encode.call(this, type, data)
            }
            try {
                assert.throws(() => f.redeem(), /gift-codec-test/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(snapshot(f), before)
        }
        assert.equal(f.status(f.redeem()), 0)
        assert.equal(f.state().mail[0].guid, String(0x8000000000000001n))
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
test('finite gift mail expires at exact boundary; permanent gift mail remains collectible', () => {
    const f = fixture({
        config: source([
            promotion(),
            promotion({ id: 'permanent', code: 'PERMANENT', mail: { ...promotion().mail, duration: 0 } }),
        ]),
    })
    try {
        f.redeem()
        const limited = f.state().mail[0].guid
        f.redeem('PERMANENT')
        const forever = f.state().mail[1].guid
        f.time(initial + 60)
        assert.throws(() => f.call('FetchMail', { u64: limited }), error(ErrorCode.MailOverTime))
        f.call('FetchMail', { u64: forever })
        assert.equal(f.state().mail[1].fetch, true)
    } finally {
        f.store.close()
    }
})
test('actual temporary SQLite reopen preserves mail text, duration and receipt through claim and deletion', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-gift-code-')),
        filename = path.join(dir, 'gift.sqlite')
    let f = fixture({ filename })
    try {
        f.redeem()
        const original = f.state().mail[0],
            guid = original.guid
        f.store.close()
        f = fixture({ filename })
        assert.deepEqual(f.state().mail[0], original)
        assert.equal(f.status(f.redeem()), 3)
        f.call('FetchMail', { u64: guid })
        const gold = f.state().player.basic_info.gold
        f.call('DelMail', { u64: guid })
        f.store.close()
        f = fixture({ filename })
        assert.equal(f.state().mail.length, 0)
        assert.equal(f.status(f.redeem()), 3)
        assert.equal(f.state().player.basic_info.gold, gold)
    } finally {
        f.store.close()
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('whole-list static capacity rejects duplicate/cross-ID eggs, normal/custom pets, equipment and ornaments', () => {
    const count = (name) => Number(tables.get('game').find((row) => row.title === name).value),
        eggs = tables.get('pet_egg'),
        eggCapacity = count('PET_EGG_LIMITS'),
        petCapacity = count('PET_BOX_NUM') * count('PET_BOX_LIMIT'),
        pet = tables.get('pet').find((row) => tables.find('template_value', row.id)).id,
        custom = tables.get('pet_customized')[0].id,
        equipment = tables.get('soulessence')[0].id,
        ornament = tables.get('accessory_customed')[0].id,
        reward = (itemtype, itemid, itemnum) => ({ itemtype, itemid, itemnum })
    const rejected = [
        [reward(14, 20004001, 1000), reward(14, 20004001, 1000)],
        [reward(14, eggs[0].id, eggCapacity), reward(14, eggs[1].id, 1)],
        [reward(5, pet, petCapacity), reward(30, custom, 1)],
        Array.from({ length: 11 }, () => reward(9, equipment, 1000)),
        Array.from({ length: 11 }, () => reward(33, ornament, 1000)),
    ]
    for (const rewards of rejected) {
        const original = structuredClone(rewards)
        assert.throws(() => validateRewardTotals(tables, rewards), error(ErrorCode.GameConfig))
        assert.throws(() => validateRewardDefinitions(tables, rewards), error(ErrorCode.GameConfig))
        assert.deepEqual(rewards, original)
    }
    for (const rewards of [
        [reward(14, eggs[0].id, eggCapacity - 1), reward(14, eggs[1].id, 1)],
        [reward(5, pet, petCapacity - 1), reward(30, custom, 1)],
        Array.from({ length: 10 }, () => reward(9, equipment, 1000)),
        Array.from({ length: 10 }, () => reward(33, ornament, 1000)),
    ])
        assert.doesNotThrow(() => validateRewardDefinitions(tables, rewards))
})
test('same resource, currency and reputation aliases share numeric bounds and unique definitions cannot repeat', () => {
    const reward = (itemtype, itemid, itemnum) => ({ itemtype, itemid, itemnum }),
        building = tables.get('home_building')[0].id,
        task = tables.get('task_item')[0].id,
        group = tables.get('reputation_level')[0].reputationId,
        alias = tables.find('groups', group).reputation,
        title = tables.get('player_title').find((row) => [1, 2].includes(row.type)).id
    for (const rewards of [
        [reward(3, 400000, 0xffffffff), reward(3, 400000, 1)],
        [reward(13, building, 0xffffffff), reward(13, building, 1)],
        [reward(20, task, 99), reward(20, task, 1)],
        [reward(10, 1, 0x7fffffff), reward(10, 1, 1)],
        [reward(10, 2, 0x7fffffff), reward(10, 2, 1)],
        [reward(29, group, 0xffffffff), reward(29, alias, 1)],
        [reward(17, title, 1), reward(17, title, 1)],
    ])
        assert.throws(() => validateRewardDefinitions(tables, rewards), error(ErrorCode.GameConfig))
    assert.doesNotThrow(() => validateRewardDefinitions(tables, [reward(3, 400000, 0xfffffffe), reward(3, 400000, 1)]))
    assert.doesNotThrow(() => validateRewardDefinitions(tables, [reward(10, 2, 0x7ffffffe), reward(10, 2, 1)]))
})
test('real6131 rejects impossible whole-mail attachments before status0, allocator, mail or receipt mutation', () => {
    const f = fixture({
        config: source([
            promotion({
                rewards: [
                    { itemtype: 3, itemid: 400000, itemnum: 1 },
                    { itemtype: 14, itemid: 20004001, itemnum: 1000 },
                    { itemtype: 14, itemid: 20004001, itemnum: 1000 },
                ],
            }),
        ]),
    })
    try {
        const before = snapshot(f)
        assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(f), before)
        assert.equal(f.state().mail.length, 0)
        assert.equal(f.state().giftCodeClaims, undefined)
    } finally {
        f.store.close()
    }
})
test('only undefined claim ledger initializes; null, invalid stable ID or duplicate receipt mail rejects atomically', () => {
    const f = fixture()
    try {
        assert.equal(f.status(f.redeem()), 0)
        const valid = structuredClone(f.state().giftCodeClaims),
            receipt = valid.by_id['test-promotion'],
            mail = structuredClone(f.state().mail[0])
        for (const damaged of [
            null,
            [],
            'broken',
            { schema_version: 1, by_id: null },
            { schema_version: 1, by_id: { 'bad id': { ...receipt, id: 'bad id' } } },
            { schema_version: 1, by_id: { first: { ...receipt, id: 'first' }, second: { ...receipt, id: 'second' } } },
        ]) {
            f.store.transact(f.session.id, 0, (s) => {
                s.giftCodeClaims = damaged
            })
            const before = snapshot(f)
            assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
            assert.deepEqual(snapshot(f), before)
            assert.deepEqual(f.state().mail, [mail])
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.giftCodeClaims = valid
        })
        assert.equal(f.status(f.redeem()), 3)
        assert.deepEqual(f.state().mail, [mail])
    } finally {
        f.store.close()
    }
})
test('actual SQLite reopen preserves null corruption and denies second mail plus aggregate overflow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-gift-integrity-')),
        filename = path.join(dir, 'gift.sqlite'),
        config = source([
            promotion(),
            promotion({
                id: 'oversized',
                code: 'TOO-MANY',
                rewards: [
                    { itemtype: 14, itemid: 20004001, itemnum: 1000 },
                    { itemtype: 14, itemid: 20004001, itemnum: 1000 },
                ],
            }),
        ])
    let f = fixture({ filename, config })
    try {
        assert.equal(f.status(f.redeem()), 0)
        const mail = structuredClone(f.state().mail[0])
        const bounded = snapshot(f)
        assert.throws(() => f.redeem('TOO-MANY'), error(ErrorCode.GameConfig))
        assert.deepEqual(snapshot(f), bounded)
        f.store.transact(f.session.id, 0, (s) => {
            s.giftCodeClaims = null
        })
        f.store.close()
        f = fixture({ filename, config })
        for (let n = 0; n < 2; n++) {
            const before = snapshot(f)
            assert.throws(() => f.redeem(), error(ErrorCode.GameConfig))
            assert.deepEqual(snapshot(f), before)
            assert.equal(f.state().giftCodeClaims, null)
            assert.deepEqual(f.state().mail, [mail])
        }
    } finally {
        f.store.close()
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
