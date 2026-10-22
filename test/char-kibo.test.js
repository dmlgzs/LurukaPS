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
import { grantRewards } from '../src/rewards.js'
import { createPets } from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
const rows = tables.get('char_kibo').filter((r) => r.getType === 1)
const heroAt = (state, id = 107002) => state.player.heros_info.heros.find((h) => h.conf_id === id)
function fixture(source = tables, file = ':memory:') {
    const store = new Store(file),
        protocol = new Protocol(cfg.base)
    const game = new Game(protocol, store, source, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'char-kibo' })
    }
    reload()
    store.transact(session.id, 0, (state) => {
        state.pets = []
        state.petBoxes = []
        state.recordPets = []
        state.tasks = []
        state.taskRecords = source
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
        for (const hero of state.player.heros_info.heros) {
            hero.pet_id = '0'
            hero.favorability_lv = 6
        }
        for (const m of state.player.group_mgrs) for (const g of m.groups) for (const h of g.heros) h.pet_id = '0'
    })
    reload()
    const state = () => store.load(session.id).state
    const claim = (id = 107002, request = {}) =>
        call('PetGetCharKibo', {
            hero_guid: heroAt(state(), id).guid,
            config_id: Number(source.find('hero', id).kiboId),
            ...request,
        })
    return {
        store,
        protocol,
        call,
        claim,
        state,
        reload,
        get session() {
            return session
        },
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
const ack = (packets) => packets.find((p) => p.id === 11032).data
function assertUnchangedFailure(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (error) => error.code === code)
    assert.deepEqual(f.state(), before)
}
function override(find) {
    const source = Object.create(tables)
    source.find = (name, id) => find(name, id, tables.find(name, id))
    return source
}

test('all eleven manual exclusive pets use their current templates, real GUIDs, fixed aptitudes/genes/labor and mount speed', () => {
    assert.equal(rows.length, 11)
    const f = fixture()
    try {
        for (const row of rows) {
            const config = tables.find('pet_customized', Number(row.unlockReward.split('#')[1]))
            const out = f.claim(row.id),
                result = ack(out)
            assert.equal(result.src, 159)
            assert.equal(result.rewards.length, 1)
            const reward = result.rewards[0],
                s = f.state(),
                pet = s.pets.find((p) => p.guid === reward.guid)
            assert(pet)
            assert.equal(reward.itemtype, 30)
            assert.equal(reward.itemid, config.id)
            assert.equal(pet.config_id, config.petId)
            assert.equal(pet.customized_id, config.id)
            assert.equal(pet.can_not_release, true)
            assert.equal(pet.lv, config.level)
            const aptitudes = new Map(config.petAttr.split('|').map((t) => t.split('#').map(Number)))
            assert.equal(pet.comprehension.length, aptitudes.size)
            for (const a of pet.comprehension) {
                assert.equal(a.level, aptitudes.get(a.attr_id))
                assert.equal(a.init_level, a.level)
                const range = tables
                    .get('pet_talent_upgrade')
                    .find((r) => r.attrId === a.attr_id && r.level === a.level)
                assert(a.value >= range.InterA && a.value <= range.InterB)
            }
            assert.deepEqual(
                pet.gene_infos.map((g) => g.gene_id),
                [config.talentDna, ...config.dna.split('|').map(Number)],
            )
            assert.deepEqual(
                pet.labor_infos.map((l) => l.labor_grade),
                config.laborScore.split('|').map(Number),
            )
            if (config.mountType === 1) assert.equal(pet.speed, config.mountSpeed)
            assert(pet.grade > 0)
            const pushes = assertSyncBefore(f.protocol, out, 'CSProtoPetInfoSync', 11032)
            assert(pushes.some((p) => p.data.pet_infos.pets.some((p) => p.guid === pet.guid)))
            assert(pushes.some((p) => p.data.record_pets.includes(pet.config_id)))
            assert.equal(s.charKiboClaims[row.id].guid, pet.guid)
            assert.equal(heroAt(s, row.id).char_kibo_state, undefined)
            // These exclusive variants have no iconographyTaskId. Do not
            // invent a task/level row merely to force a 11020 notification.
            assert.equal(s.petHandbook[pet.config_id], undefined)
            assert.deepEqual(ack(f.claim(row.id)).rewards, [])
            assert.equal(f.state().pets.length, s.pets.length)
        }
        assert.equal(new Set(f.state().pets.map((p) => p.guid)).size, rows.length)
        assert.equal(new Set(f.state().pets.map((p) => p.box_id)).size, rows.length)
    } finally {
        f.close()
    }
})

test('the shared reward path retains all 23 current customized templates and honors fixed work scores without enabling unconfigured mounts', () => {
    const f = fixture()
    try {
        for (const config of tables.get('pet_customized')) {
            f.edit((s) => grantRewards(tables, s, [{ itemtype: 30, itemid: config.id, itemnum: 1 }]))
            const pet = f.state().pets.find((p) => p.customized_id === config.id)
            assert(pet)
            assert.deepEqual(
                pet.labor_infos.map((l) => l.labor_grade),
                config.laborScore.split('|').map(Number),
            )
            if (config.mountType === 1) assert.equal(pet.speed, config.mountSpeed)
        }
        assert.equal(f.state().pets.length, 23)
        assert.equal(tables.find('mount', 500751), undefined)
        assert.equal(f.state().pets.find((p) => p.config_id === 500751).speed, 10000)
    } finally {
        f.close()
    }
})

test('the real gift endpoint crosses the table favorability threshold before an exclusive claim becomes eligible', () => {
    const f = fixture()
    try {
        const gift = tables
            .get('hero_favorability_gift')
            .find((g) => String(g.favourHero).split('|').includes('107002'))
        const threshold = tables.get('hero_favorability_exp').find((r) => r.favorabilityLevel === 5).favorabilityExp
        f.edit((s) => {
            heroAt(s).favorability_lv = 5
            heroAt(s).favorability_exp = threshold - gift.favourValue
            grantRewards(tables, s, [{ itemtype: 3, itemid: gift.id, itemnum: 1 }])
        })
        assertUnchangedFailure(f, () => f.claim(), ErrorCode.InvalidArgument)
        f.call('SendHeroGift', { heroId: 107002, item_id: gift.id, item_type: 110, num: 1 })
        assert.equal(heroAt(f.state()).favorability_lv, 6)
        assert.equal(heroAt(f.state()).favorability_exp, 0)
        assert.equal(ack(f.claim()).rewards.length, 1)
    } finally {
        f.close()
    }
})

test('claims reject foreign/missing/trial heroes, mismatched pets and the story-only hero even after its task is finished', () => {
    const f = fixture()
    try {
        const other = {}
        f.call('EnterGame', { open_id: 'other-char-kibo' }, other)
        const foreign = heroAt(f.store.load(other.id).state).guid
        assertUnchangedFailure(f, () => f.claim(107002, { hero_guid: foreign }), ErrorCode.HeroNotExist)
        assertUnchangedFailure(f, () => f.claim(107002, { hero_guid: '0' }), ErrorCode.HeroNotExist)
        assertUnchangedFailure(f, () => f.claim(107002, { config_id: 500748 }), ErrorCode.InvalidArgument)
        assertUnchangedFailure(f, () => f.claim(108001), ErrorCode.InvalidArgument)
        f.edit((s) => {
            heroAt(s).trail = true
        })
        assertUnchangedFailure(f, () => f.claim(), ErrorCode.HeroNotExist)
    } finally {
        f.close()
    }
})

test('existing permanent ownership is adopted without duplicate rewards; private receipts also prevent reissue after external removal', () => {
    const f = fixture()
    try {
        f.edit((s) => createPets(tables, s, 500751, 1))
        const original = f.state().pets[0]
        assert.deepEqual(ack(f.claim()).rewards, [])
        assert.equal(f.state().pets.length, 1)
        assert.equal(f.state().charKiboClaims[107002].guid, original.guid)
        f.edit((s) => {
            s.pets = []
            s.petRevision++
        })
        assert.deepEqual(ack(f.claim()).rewards, [])
        assert.equal(f.state().pets.length, 0)
    } finally {
        f.close()
    }
})

test('temporary species do not substitute for exclusive ownership and configured box capacity is enforced atomically', () => {
    const f = fixture()
    try {
        f.edit((s) => {
            createPets(tables, s, 500751, 1)[0].type = 2
        })
        assert.equal(ack(f.claim()).rewards.length, 1)
        f.edit((s) => {
            s.pets = []
            s.petBoxes = []
            delete s.charKiboClaims
            const capacity =
                Number(tables.get('game').find((r) => r.title === 'PET_BOX_NUM').value) *
                Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT').value)
            createPets(tables, s, 500002, capacity)
        })
        assertUnchangedFailure(f, () => f.claim(), ErrorCode.MailPetFull)
        f.edit((s) => {
            s.pets.pop()
            s.petRevision++
        })
        assert.equal(ack(f.claim()).rewards.length, 1)
    } finally {
        f.close()
    }
})

test('broken or unsupported table references and malformed saved receipts never silently unlock or partially issue pets', () => {
    for (const [table, change, expected] of [
        ['char_kibo', (r) => ({ ...r, unlockCondition: '' }), ErrorCode.GameConfig],
        ['char_kibo', (r) => ({ ...r, unlockCondition: '13000#107002#999' }), ErrorCode.GameConfig],
        ['char_kibo', (r) => ({ ...r, unlockCondition: '13051#107002#6' }), ErrorCode.InvalidProtoID],
        ['char_kibo', (r) => ({ ...r, unlockReward: '' }), ErrorCode.HeroFavorRewardEmpty],
        ['char_kibo', (r) => ({ ...r, unlockReward: '30#500748#1' }), ErrorCode.GameConfig],
        ['pet_customized', (r) => ({ ...r, laborScore: '30|30' }), ErrorCode.GameConfig],
        ['pet_customized', (r) => ({ ...r, laborScoreType: 2 }), ErrorCode.InvalidProtoID],
        ['pet_customized', (r) => ({ ...r, mountType: 'fixed' }), ErrorCode.GameConfig],
        ['pet_customized', (r) => ({ ...r, mountSpeed: 0 }), ErrorCode.GameConfig],
    ]) {
        const f = fixture(
            override((n, id, row) =>
                n === table && id === (table === 'char_kibo' ? 107002 : 500751) ? change(row) : row,
            ),
        )
        try {
            assertUnchangedFailure(f, () => f.claim(), expected)
        } finally {
            f.close()
        }
    }
    const f = fixture()
    try {
        f.edit((s) => {
            s.charKiboClaims = { [107002]: { hero_id: 107002, pet_id: 500748, guid: '1', time: 1 } }
        })
        assertUnchangedFailure(f, () => f.claim(), ErrorCode.GameConfig)
    } finally {
        f.close()
    }
})

test('reward ACK or pre-ACK pet encoding failures roll back the instance, catalog history, sequence and receipt', () => {
    for (const name of ['CSProtoPetGetCharKibo', 'CSProtoPetInfoSync']) {
        const f = fixture()
        try {
            const encode = f.protocol.encode.bind(f.protocol),
                type = f.protocol.byName.get(name).rsp
            const before = f.state()
            f.protocol.encode = (n, v) => {
                if (n === type) throw Error('injected claim codec failure')
                return encode(n, v)
            }
            assert.throws(() => f.claim(), /injected claim codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            assert.equal(ack(f.claim()).rewards.length, 1)
            assert.deepEqual(ack(f.claim()).rewards, [])
        } finally {
            f.close()
        }
    }
})

test('a missing optional reward source logs and still grants the exclusive pet', () => {
    const f = fixture(override((name, id, row) => (name === 'reason_itemnum_change' && id === 159 ? undefined : row)))
    try {
        const result = ack(f.claim())
        assert.equal(result.rewards.length, 1)
        assert.equal(f.state().pets.length, 1)
        assert.equal(result.src ?? 0, 0)
    } finally {
        f.close()
    }
})

test('exclusive instance and receipt survive an actual SQLite close/reopen without issuing another pet', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-char-kibo-')),
        file = path.join(directory, 'state.sqlite')
    let f, reopened
    try {
        f = fixture(tables, file)
        const reward = ack(f.claim()).rewards[0],
            id = f.session.id
        const before = f.state().pets.find((p) => p.guid === reward.guid)
        f.close()
        f = undefined
        reopened = new Store(file)
        const state = reopened.load(id).state
        assert.deepEqual(
            state.pets.find((p) => p.guid === reward.guid),
            before,
        )
        assert.equal(state.charKiboClaims[107002].guid, reward.guid)
        const protocol = new Protocol(cfg.base),
            game = new Game(protocol, reopened, tables),
            session = {}
        const dispatch = (name, data) => {
            const e = protocol.byName.get('CSProto' + name)
            const packets = game.dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, data) })
            return protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
        }
        dispatch('EnterGame', { open_id: 'char-kibo' })
        assert.deepEqual(dispatch('PetGetCharKibo', { hero_guid: heroAt(state).guid, config_id: 500751 }).rewards, [])
        assert.equal(reopened.load(id).state.pets.length, 1)
    } finally {
        f?.close()
        reopened?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-char-kibo-'))
        fs.rmSync(directory, { recursive: true })
    }
})
