import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { handbookPlan, preparePetHandbook, petHandbookSnapshot, petHandbookAttributes } from '../src/pet-handbook.js'
import { petModules } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function aptitude(pet, level) {
    pet.comprehension = tables.get('pet_learningenum').map(({ attributeEnum: attr_id }) => ({
        attr_id,
        level,
        init_level: 1,
        cur_exp: 0,
        value: tables.get('pet_talent_upgrade').find((r) => r.attrId === attr_id && r.level === level).InterA,
    }))
}
function fixture(file = ':memory:', count = 1) {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        initialSession = {}
    let session = initialSession
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'pet-handbook' })
    store.transact(session.id, 0, (state) => {
        state.player.basic_info.lv = 100
        state.player.basic_info.gold = 1000000000
        state.tasks = []
        state.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        state.pets = []
        state.petBoxes = []
        state.recordPets = []
        for (const hero of state.player.heros_info.heros) hero.pet_id = '0'
        for (const manager of state.player.group_mgrs)
            for (const g of manager.groups) for (const hero of g.heros) hero.pet_id = '0'
        for (const pet of createPets(tables, state, 500001, count)) aptitude(pet, 1)
    })
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'pet-handbook' })
    }
    const login = reload()
    const state = () => store.load(session.id).state,
        guid = state().pets[0].guid
    const signature = state().pets[0].inherent_skills.find((s) => s.skill_slot === 206).skill_id
    const cast = (index, overrides = {}) =>
        call('SkillStart', {
            unit_id: guid,
            skill: { skill_id: signature },
            op_time: String(index * 1000),
            verify_info: { source_type: 1, battle_index: String(index) },
            ...overrides,
        })
    return {
        store,
        game,
        get session() {
            return session
        },
        reload,
        call,
        state,
        guid,
        cast,
        login,
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
const handbook = (f) => f.state().petHandbook[500001]
const claim = (f) => f.call('PetHandbookRewardGet')

test('all visible species compile their complete task chains and current level/attribute rewards', () => {
    const visible = tables.get('pet').filter(
        (p) =>
            p.iconographyshow === 1 &&
            String(p.iconographyTaskId)
                .split('|')
                .some((n) => Number(n) > 0),
    )
    assert.equal(visible.length, 190)
    let tasks = 0
    for (const config of visible) {
        const plan = handbookPlan(tables, config.id)
        assert(plan)
        const specimen = { guid: 'owned', config_id: config.id, type: 1, lv: 100 }
        aptitude(specimen, 7)
        const state = {
            pets: [specimen],
            recordPets: [config.id],
            petRevision: 1,
            petHandbookCasts: { [config.id]: plan.maxCasts },
        }
        preparePetHandbook(tables, state)
        const row = state.petHandbook[config.id]
        assert.equal(row.lv, 10)
        assert.equal(row.exp, 0)
        assert.equal(row.rewarded_lv, 1)
        assert.equal(row.total_exp, 180)
        assert(row.tasks.every((t) => t.complete))
        assert.equal(row.completed_tasks.length, 18)
        assert.equal(plan.levels.length, 10)
        tasks += row.completed_tasks.length
        const snapshot = petHandbookSnapshot(state)
        protocol.encode('SCPetHandbookInfoSync', snapshot)
        assert(!Object.hasOwn(snapshot.infos[0], 'max_level'))
    }
    assert.equal(tasks, 3420) // The other18 rows belong to a hidden species.
})

test('login publishes an earned baseline entry while excluding the old debug starter roster', () => {
    const f = fixture()
    try {
        const entry = f.login.find((p) => p.id === 11020).data.infos.find((p) => p.pet_id === 500001)
        assert.equal(entry.lv, 1)
        assert.equal(entry.rewarded_lv, 1)
        assert.equal(entry.had, true)
        assert.equal(entry.tasks.length, 3)
        assert.deepEqual(Object.keys(f.state().petHandbook), ['500001'])
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.PetHandbookLvNotReached,
        )
    } finally {
        f.close()
    }
})

test('real level-up and six fruit training advance different configured chains and unlock claimable level rewards', () => {
    const f = fixture()
    try {
        const material = Number(String(tables.get('game').find((r) => r.title === 'PET_EXPITEMID').value).split('|')[0])
        const need = tables
            .get('pet_level')
            .filter((r) => r.lv < 30)
            .reduce((n, r) => n + r.exp, 0)
        const count = Math.ceil(need / Number(tables.find('common_item', material).useFunction))
        const fruits = tables.get('pet_feed_item').filter((r) => r.type === 1)
        f.edit((state) =>
            grantRewards(tables, state, [
                { itemtype: 3, itemid: material, itemnum: count },
                ...fruits.map((r) => ({ itemtype: 3, itemid: r.id, itemnum: 1 })),
            ]),
        )
        const raised = f.call('LvUpPet', { pet_id: f.guid, items: [{ item_id: material, item_num: count }] })
        assert(f.state().pets[0].lv >= 30 && f.state().pets[0].lv < 50)
        assert.equal(handbook(f).lv, 2)
        assert(handbook(f).completed_tasks.includes(6))
        assert(!handbook(f).completed_tasks.includes(13))
        assertSyncBefore(protocol, raised, 'CSProtoPetHandbookInfoSync', protocol.byName.get('CSProtoLvUpPet').id)
        const latestStats = raised
            .filter((p) => p.id === protocol.byName.get('CSProtoHeroAttrInfoSync').id)
            .flatMap((p) => p.data.heros)
            .filter((h) => h.hero_guid === f.guid)
            .at(-1)
        assert(latestStats)
        assert.equal(
            latestStats.modules
                .find((m) => m.module_type === 8)
                .sub_modules[0].attrs.attrs.find((a) => a.attr_id === 2001).attr_val,
            '16',
        )
        f.call('LvUpComprehension', { pet_id: f.guid, items: fruits.map((r) => ({ item_id: r.id, item_num: 1 })) })
        assert.equal(handbook(f).max_talent, 2)
        assert(handbook(f).completed_tasks.includes(13))
        assert.equal(handbook(f).lv, 3)
        const before = f.state(),
            out = claim(f),
            response = out.find((p) => p.id === 11021).data.reward
        assert.equal(response.src, 105)
        assert.equal(response.rewards.find((r) => r.itemtype === 3 && r.itemid === 1720001).itemnum, 5)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 2000)
        assert.equal(stock(f.state(), 1720001), stock(before, 1720001) + 5)
        assert.equal(handbook(f).rewarded_lv, 3)
        assertSyncBefore(protocol, out, 'CSProtoPetHandbookInfoSync', 11021)
        assertSyncBefore(protocol, out, 'CSProtoSyncPlayerData', 11021)
        const after = f.store.load(f.session.id)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.PetHandbookRewardClaimed,
        )
        assert.deepEqual(f.store.load(f.session.id), after)
    } finally {
        f.close()
    }
})

test('talent is the minimum of six dimensions on one specimen, never pet rank or a combination of different pets', () => {
    const f = fixture(':memory:', 2)
    try {
        f.edit((state) => {
            const [a, b] = state.pets
            aptitude(a, 7)
            aptitude(b, 7)
            a.comprehension[0].level = 1
            b.comprehension[1].level = 1
            a.rank = 7
            b.rank = 7
            state.petRevision++
        })
        f.reload()
        assert.equal(handbook(f).max_talent, 1)
        assert(!handbook(f).completed_tasks.includes(13))
        f.edit((state) => {
            aptitude(state.pets[0], 2)
            state.petRevision++
        })
        f.reload()
        assert.equal(handbook(f).max_talent, 2)
        assert(handbook(f).completed_tasks.includes(13))
    } finally {
        f.close()
    }
})

test('signature cast thresholds update in memory, deduplicate receipts and synchronize only affected pet attributes', () => {
    const f = fixture(':memory:', 2)
    try {
        const changes = () => f.store.db.prepare('select total_changes() as n').get().n
        const before = changes()
        f.cast(1)
        f.cast(1)
        f.cast(2)
        assert.equal(f.state().petHandbookCasts[500001], 2)
        assert.equal(handbook(f).lv, 1)
        const out = f.cast(3)
        assert.equal(changes(), before)
        assert.equal(f.state().petHandbookCasts[500001], 3)
        assert.equal(handbook(f).lv, 2)
        assert.equal(out.find((p) => p.id === 11020).data.infos[0].lv, 2)
        const sync = out.find((p) => p.id === protocol.byName.get('CSProtoHeroAttrInfoSync').id)
        assert(sync)
        assert.equal(sync.data.heros.length, 2)
        for (const info of sync.data.heros)
            assert.equal(
                info.modules.find((m) => m.module_type === 8).sub_modules[0].attrs.attrs.find((a) => a.attr_id === 2001)
                    .attr_val,
                '16',
            )
        for (let i = 4; i <= 50; i++) f.cast(i)
        assert.equal(f.state().petHandbookCasts[500001], 50)
        const row = structuredClone(handbook(f))
        f.cast(51)
        f.cast(52)
        assert.deepEqual(handbook(f), row)
        assert.equal(f.state().petHandbookCasts[500001], 50)
        assert.equal(changes(), before)
    } finally {
        f.close()
    }
})

test('ordinary attacks and invalid actors do not count; a failed handbook packet cannot leak into the pending combat state', () => {
    const f = fixture(),
        packet = f.game.packet
    try {
        const ordinary = f.state().pets[0].inherent_skills.find((s) => s.skill_slot === 1).skill_id
        f.cast(1, { skill: { skill_id: ordinary } })
        assert.equal(f.state().petHandbookCasts?.[500001] ?? 0, 0)
        assert.throws(() => f.cast(1, { unit_id: '144115188075855871' }))
        f.cast(2)
        f.cast(3)
        const before = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoPetHandbookInfoSync') throw Error('handbook skill sync failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.cast(4), /handbook skill sync failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.equal(f.state().petHandbookCasts[500001], 2)
        assert.equal(handbook(f).lv, 1)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHeroAttrInfoSync') throw Error('handbook attribute sync failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.cast(4), /handbook attribute sync failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.cast(4)
        assert.equal(handbook(f).lv, 2)
    } finally {
        f.game.packet = packet
        f.close()
    }
})

test('all eligible tiers are granted once and reward encoding failures roll back both inventory and rewarded levels', () => {
    const f = fixture(),
        encode = protocol.encode
    try {
        f.edit((state) => {
            state.pets[0].lv = 100
            aptitude(state.pets[0], 7)
            state.petRevision++
            state.petHandbookCasts = { 500001: 50 }
        })
        f.reload()
        assert.equal(handbook(f).lv, 10)
        const before = f.store.load(f.session.id),
            entry = protocol.byName.get('CSProtoPetHandbookRewardGet')
        protocol.encode = function (type, data, ...args) {
            if (type === entry.rsp) throw Error('handbook reward reply failed')
            return encode.call(this, type, data, ...args)
        }
        assert.throws(() => claim(f), /handbook reward reply failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        protocol.encode = encode
        const expected = new Map()
        for (const row of handbookPlan(tables, 500001).levels.filter((r) => r.iconographyLevel > 1))
            for (const reward of parseRewards(row.reward))
                expected.set(
                    reward.itemtype + ':' + reward.itemid,
                    (expected.get(reward.itemtype + ':' + reward.itemid) ?? 0) + reward.itemnum,
                )
        const out = claim(f),
            response = out.find((p) => p.id === 11021).data.reward
        assert.equal(response.rewards.length, expected.size)
        for (const reward of response.rewards)
            assert.equal(reward.itemnum, expected.get(reward.itemtype + ':' + reward.itemid))
        assert.equal(handbook(f).rewarded_lv, 10)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.PetHandbookRewardClaimed,
        )
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('world handbook flat and first-element bonuses follow earned levels and never depend on claiming loot', () => {
    const state = {
        recordPets: [500001],
        pets: [{ guid: 'earned', config_id: 500001, type: 1, lv: 100 }],
        petRevision: 1,
    }
    aptitude(state.pets[0], 7)
    state.petHandbookCasts = { 500001: 50 }
    preparePetHandbook(tables, state)
    assert.equal(state.petHandbook[500001].rewarded_lv, 1)
    const own = petHandbookAttributes(tables, state, state.pets[0])
    assert.equal(own.get(2001), 40)
    assert.equal(own.get(2003), 8)
    assert.equal(own.get(2005), 80)
    const element = String(tables.find('pet', 500001).element).split('|')[0]
    const other = tables
        .get('pet')
        .find(
            (p) =>
                p.id !== 500001 && String(p.element).split('|')[0] === element && tables.find('template_value', p.id),
        )
    assert(other)
    const shared = petHandbookAttributes(tables, state, { config_id: other.id, type: 1 })
    assert.equal(shared.get(2001), 24)
    assert.equal(shared.size, 1)
    assert.equal(petHandbookAttributes(tables, state, { config_id: other.id, type: 2 }).size, 0)
    const info = petModules(tables, state, state.pets[0], [])
    assert(info.modules.some((m) => m.module_type === 8))
})

test('duplicate current level keys use one deterministic reward row without summing conflicting attribute definitions', () => {
    for (const id of [500764, 500765, 500766]) {
        const plan = handbookPlan(tables, id)
        assert(plan.ambiguous)
        assert.equal(plan.levels.length, 10)
        for (const row of plan.levels) {
            const duplicates = tables
                .get('iconography_level')
                .filter((r) => r.petid === id && r.iconographyLevel === row.iconographyLevel)
            assert.equal(row.id, Math.min(...duplicates.map((r) => r.id)))
            assert(duplicates.every((r) => r.reward === row.reward && r.exp === row.exp))
        }
    }
})

test('owned progress survives releasing the specimen and a real database restart without paying claimed tiers again', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-pet-handbook-'))
    const file = path.join(directory, 'state.sqlite'),
        f = fixture(file)
    let restored,
        closed = false
    try {
        for (let i = 1; i <= 15; i++) f.cast(i)
        assert.equal(handbook(f).lv, 4)
        claim(f)
        f.edit((state) => {
            state.pets[0].is_lock = false
        })
        f.call('DelPet', { pet_list: [f.guid] })
        const before = f.state()
        assert.equal(before.pets.length, 0)
        assert.equal(before.petHandbook[500001].lv, 4)
        assert.equal(before.petHandbook[500001].rewarded_lv, 4)
        f.close()
        closed = true
        restored = new Store(file)
        const game = new Game(protocol, restored, tables),
            session = {},
            enter = protocol.byName.get('CSProtoEnterGame')
        const packets = game.dispatch(session, {
            id: enter.id,
            seq: 1,
            payload: protocol.encode(enter.req, { open_id: 'pet-handbook' }),
        })
        const saved = restored.load(session.id).state
        assert.equal(saved.petHandbookCasts[500001], 15)
        assert.deepEqual(saved.petHandbook[500001], before.petHandbook[500001])
        assert.equal(stock(saved, 1720001), stock(before, 1720001))
        const info = packets.find((p) => p.id === 11020)
        assert(info)
        assert.equal(protocol.decode('SCPetHandbookInfoSync', info.payload).infos[0].rewarded_lv, 4)
        const request = protocol.byName.get('CSProtoPetHandbookRewardGet')
        assert.throws(
            () => game.dispatch(session, { id: request.id, seq: 2, payload: protocol.encode(request.req, {}) }),
            (e) => e.code === ErrorCode.PetHandbookRewardClaimed,
        )
    } finally {
        if (!closed) f.close()
        restored?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-pet-handbook-'))
        fs.rmSync(directory, { recursive: true })
    }
})

test('invalid saved reward markers cannot bypass eligibility or consume an earlier valid species reward', () => {
    const f = fixture()
    try {
        f.cast(1)
        f.cast(2)
        f.cast(3)
        f.edit((state) => {
            state.petHandbook[500001].rewarded_lv = 10
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('the empty claim request pays every eligible species atomically and validates later saved markers first', () => {
    const f = fixture()
    try {
        f.edit((state) => {
            const [other] = createPets(tables, state, 500002, 1)
            aptitude(other, 1)
            for (const pet of state.pets) pet.lv = 30
            state.petRevision++
        })
        f.reload()
        assert.equal(f.state().petHandbook[500001].lv, 2)
        assert.equal(f.state().petHandbook[500002].lv, 2)
        f.edit((state) => {
            state.petHandbook[500002].rewarded_lv = 3
        })
        const bad = f.store.load(f.session.id)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), bad)
        f.edit((state) => {
            state.petHandbook[500002].rewarded_lv = 1
        })
        const before = f.state(),
            response = claim(f).find((p) => p.id === 11021).data.reward
        assert.equal(response.rewards.find((r) => r.itemid === 1720001).itemnum, 4)
        assert.equal(stock(f.state(), 1720001), stock(before, 1720001) + 4)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 1600)
        assert.equal(f.state().petHandbook[500001].rewarded_lv, 2)
        assert.equal(f.state().petHandbook[500002].rewarded_lv, 2)
    } finally {
        f.close()
    }
})

test('unknown conditions are distinct from missing or malformed catalog configuration', () => {
    const fake = (table, map) => ({
        get: (name) => (name === table ? map(tables.get(name)) : tables.get(name)),
        find: tables.find.bind(tables),
    })
    const unknown = fake('iconography_task', (rows) =>
        rows.map((r) => (r.id === 1 ? { ...r, taskcondition: '13050|500001|1' } : r)),
    )
    assert.throws(
        () => handbookPlan(unknown, 500001),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
    const missing = fake('iconography_task', (rows) => rows.filter((r) => r.id !== 1))
    assert.throws(
        () => handbookPlan(missing, 500001),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const effect = fake('iconography_type', (rows) => rows.map((r) => (r.id === 1 ? { ...r, rewardtype: 9999 } : r)))
    assert.throws(
        () => handbookPlan(effect, 500001),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})

test('new connections may restart cast indexes while same-connection zero-sequence duplicates stay once-only', () => {
    const f = fixture()
    try {
        f.cast(1)
        f.cast(2)
        assert.equal(f.state().petHandbookCasts[500001], 2)
        f.reload()
        const entry = protocol.byName.get('CSProtoSkillStart'),
            skill = f.state().pets[0].inherent_skills.find((s) => s.skill_slot === 206)
        const frame = {
            id: entry.id,
            seq: 0,
            payload: protocol.encode(entry.req, {
                unit_id: f.guid,
                skill: { skill_id: skill.skill_id },
                op_time: '1000',
                verify_info: { source_type: 1, battle_index: '1' },
            }),
        }
        const changes = f.store.db.prepare('select total_changes() as n').get().n
        f.game.dispatch(f.session, frame)
        f.game.dispatch(f.session, frame)
        assert.equal(f.state().petHandbookCasts[500001], 3)
        assert.equal(handbook(f).lv, 2)
        assert.equal(f.store.db.prepare('select total_changes() as n').get().n, changes)
        assert(f.state().petHandbookCastReceipts.every((key) => /^[a-f0-9]{64}$/.test(key)))
    } finally {
        f.close()
    }
})

test('legal one-way starts without client identifiers still advance studies without a fabricated retry timer', () => {
    const f = fixture()
    try {
        const entry = protocol.byName.get('CSProtoSkillStart'),
            signature = f.state().pets[0].inherent_skills.find((s) => s.skill_slot === 206)
        const frame = {
            id: entry.id,
            seq: 0,
            payload: protocol.encode(entry.req, {
                unit_id: f.guid,
                skill: { skill_id: signature.skill_id },
            }),
        }
        const before = f.store.db.prepare('select total_changes() as n').get().n
        for (let i = 0; i < 3; i++) f.game.dispatch(f.session, frame)
        assert.equal(f.state().petHandbookCasts[500001], 3)
        assert.equal(handbook(f).lv, 2)
        assert.equal(f.store.db.prepare('select total_changes() as n').get().n, before)
    } finally {
        f.close()
    }
})
