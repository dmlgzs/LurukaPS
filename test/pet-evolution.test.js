import test from 'node:test'
import assert from 'node:assert/strict'
import rows from '../configs/pet-rank-tables/pet_rank.json' with { type: 'json' }
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { petData, createPets } from '../src/pets.js'
import { planPetEvolution, petEvolutionRule } from '../src/pet-evolution.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
const rng = (min, max) => (max === undefined ? 0 : min)
function fixture(name, id, level, options = {}) {
    const store = new Store(':memory:'),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables, options),
        session = {}
    let seq = 1,
        guid
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        const p = createPets(tables, s, id, 1)[0]
        p.lv = level
        guid = p.guid
    })
    const state = () => store.load(session.id).state
    return { store, protocol, session, call, guid, state, pet: () => state().pets.find((p) => p.guid === guid) }
}
test('all 112 current routes plan valid successor abilities and use real gates; terminal forms do not evolve', () => {
    let routes = 0,
        paid = 0,
        terminal = 0
    for (const row of rows) {
        const p = petData(tables, row.petId, '1', 101)
        p.lv = Math.max(1, row.levelNeed)
        if (!row.nextPetId) {
            terminal++
            assert.throws(
                () => planPetEvolution(tables, { pets: [p] }, p, rng),
                (e) => e.code === ErrorCode.PetRankUpFail,
            )
            continue
        }
        routes++
        const before = structuredClone(p),
            plan = planPetEvolution(tables, { pets: [p] }, p, rng)
        assert.equal(plan.to, row.nextPetId)
        assert.equal(plan.update.config_id, row.nextPetId)
        assert(plan.update.inherent_skills.length > 0)
        assert.equal(
            new Set(plan.update.inherent_skills.map((s) => s.skill_slot)).size,
            plan.update.inherent_skills.length,
        )
        assert.equal(plan.gold, 0)
        if (plan.costs.length) paid++
        assert.deepEqual(p, before)
        assert(!Object.hasOwn(plan.update, 'comprehension'))
        assert(!Object.hasOwn(plan.update, 'gene_infos'))
    }
    assert.equal(routes, 112)
    assert.equal(paid, 11)
    assert.equal(terminal, 93)
})
test('6510 keeps the uint64 identity, aptitudes, DNA and formation while publishing changed skills before the timeline ACK', () => {
    const f = fixture('evolve-formation', 500002, 19)
    try {
        let heroGuid
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === f.guid),
                hero = s.player.heros_info.heros.find((h) => h.conf_id === 107002)
            heroGuid = hero.guid
            p.hero_id = heroGuid
            hero.pet_id = p.guid
            p.exp = 123
            const m = s.player.group_mgrs.find((m) => m.type === 1),
                g = m.groups.find((g) => g.id === m.cur_group)
            g.heros = [
                { hero_id: heroGuid, pet_id: p.guid },
                { hero_id: '0', pet_id: '0' },
                { hero_id: '0', pet_id: '0' },
            ]
            g.control = heroGuid
            p.inherent_skills.find((s) => s.skill_id === 502151).skill_lv = 3
            p.inherent_skills.find((s) => s.skill_slot === 206).skill_lv = 4
        })
        const first = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.PetRankUpFail,
        )
        assert.deepEqual(f.state(), first)
        f.store.transact(f.session.id, 0, (s) => (s.pets.find((p) => p.guid === f.guid).lv = 20))
        const before = structuredClone(f.pet()),
            party = structuredClone(f.state().player.group_mgrs),
            count = f.state().pets.length,
            sequence = f.state().nextPetSequence
        assert(BigInt(f.guid) > 2n ** 53n)
        const packets = f.call('RankUpPet', { u64: f.guid }),
            after = f.pet(),
            ack = packets.findIndex((p) => p.id === 6510)
        assert.equal(after.guid, before.guid)
        assert.equal(after.config_id, 500003)
        assert.equal(after.rank, before.rank + 1)
        for (const key of [
            'comprehension',
            'gene_infos',
            'gene_state',
            'lv',
            'exp',
            'base_lv',
            'favor_lv',
            'favor_val',
            'box_id',
            'hero_id',
            'is_lock',
            'feature',
            'color',
        ])
            assert.deepEqual(after[key], before[key], key)
        assert.deepEqual(f.state().player.group_mgrs, party)
        assert.equal(f.state().pets.length, count)
        assert.equal(f.state().nextPetSequence, sequence)
        assert.equal(after.inherent_skills.find((s) => s.skill_id === 502151).skill_slot, 2)
        assert.equal(after.inherent_skills.find((s) => s.skill_id === 502151).skill_lv, 3)
        assert.equal(after.inherent_skills.find((s) => s.skill_id === 502162).skill_lv, 1)
        assert.equal(after.inherent_skills.find((s) => s.skill_slot === 206).skill_id, 50000302)
        assert.equal(after.inherent_skills.find((s) => s.skill_slot === 206).skill_lv, 4)
        assert(after.grade > 0)
        assert.equal(Buffer.from(after.pet_name, 'base64').toString('utf8'), '水灵偶')
        assert(f.state().recordPets.includes(500003))
        const syncId = f.protocol.byName.get('CSProtoPetInfoSync').id
        assert(
            packets
                .slice(0, ack)
                .filter((p) => p.id === syncId)
                .some((p) =>
                    f.protocol
                        .decode(f.protocol.byId.get(syncId).rsp, p.payload)
                        .pet_infos.pets.some((p) => p.guid === f.guid && p.config_id === 500003),
                ),
        )
        const attrsId = f.protocol.byName.get('CSProtoHeroAttrInfoSync').id
        assert(
            packets
                .slice(0, ack)
                .filter((p) => p.id === attrsId)
                .some((p) =>
                    f.protocol
                        .decode(f.protocol.byId.get(attrsId).rsp, p.payload)
                        .heros.some((p) => p.hero_guid === f.guid && p.hero_conf_id === 500003),
                ),
        )
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.PetRankUpFail,
        )
        assert.deepEqual(f.state(), saved)
        f.call('EnterGame', { open_id: 'evolve-formation' }, {})
        assert.equal(f.pet().config_id, 500003)
        assert.equal(f.pet().guid, f.guid)
        assert.deepEqual(f.pet().comprehension, before.comprehension)
    } finally {
        f.store.close()
    }
})
test('a material-gated mounted evolution spends the configured item and preserves mount identity, speed and nickname', () => {
    const f = fixture('evolve-mounted', 500025, 60)
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === f.guid)
            p.pet_name = Buffer.from('自定义昵称', 'utf8').toString('base64')
            p.roulette_pos = 1
            s.mountRideId = f.guid
            s.world.status = 1
            s.world.mount = f.guid
            s.world.mount_status = 2
            s.player.basic_info.gold = 1234
        })
        const before = structuredClone(f.state()),
            old = structuredClone(f.pet())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: 499001, itemnum: 1 }]))
        f.call('RankUpPet', { u64: f.guid })
        assert.equal(f.pet().config_id, 500231)
        assert.equal(f.pet().speed, old.speed)
        assert.equal(f.pet().pet_name, old.pet_name)
        assert.equal(f.state().mountRideId, f.guid)
        assert.equal(f.state().world.mount, f.guid)
        assert.equal(f.state().world.status, 1)
        assert.equal(f.state().player.basic_info.gold, 1234)
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 499001).itemnum, 0)
    } finally {
        f.store.close()
    }
})
test('role-changing evolution archives inactive training, keeps aptitudes/DNA and refuses an active building assignment', () => {
    const f = fixture('evolve-labor', 500045, 60)
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === f.guid)
            p.work_build = 42
            p.labor_infos.forEach((r) => {
                r.labor_grade = 3
                r.labor_exp = 123
            })
            grantRewards(tables, s, [{ itemtype: 3, itemid: 499002, itemnum: 1 }])
        })
        const busy = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.PetInWork,
        )
        assert.deepEqual(f.state(), busy)
        f.store.transact(f.session.id, 0, (s) => (s.pets.find((p) => p.guid === f.guid).work_build = 0))
        const old = structuredClone(f.pet())
        f.call('RankUpPet', { u64: f.guid })
        const evolved = f.pet()
        assert.equal(evolved.config_id, 500185)
        assert.deepEqual(evolved.comprehension, old.comprehension)
        assert.deepEqual(evolved.gene_infos, old.gene_infos)
        assert.deepEqual(f.state().petEvolutionProfiles[f.guid][500045].labor_infos, old.labor_infos)
        assert.deepEqual(f.state().petEvolutionProfiles[f.guid][500045].talent_id, old.talent_id)
        assert.deepEqual(
            evolved.labor_infos.map((r) => r.labor_id),
            [11],
        )
        assert.equal(f.state().petEvolutionHistory[f.guid].at(-1).from, 500045)
    } finally {
        f.store.close()
    }
})
test('compatible trained home talents survive when new talent groups are prepended by the evolved template', () => {
    const f = fixture('evolve-trainer-talents', 500079, 40)
    try {
        const trained = [20050620, 30050130, 30050220]
        f.store.transact(f.session.id, 0, (s) => {
            const pet = s.pets.find((p) => p.guid === f.guid)
            pet.talent_id = trained
            pet.labor_infos.find((r) => r.labor_id === 4).labor_exp = 456
        })
        f.call('RankUpPet', { u64: f.guid })
        assert.equal(f.pet().config_id, 500080)
        assert.deepEqual(f.pet().talent_id, trained)
        assert.equal(f.pet().labor_infos.find((r) => r.labor_id === 4).labor_exp, 456)
        assert(f.pet().labor_infos.some((r) => r.labor_id === 2))
    } finally {
        f.store.close()
    }
})
test('newly rideable forms receive a table-random mount speed once without rerolling aptitudes', () => {
    let draws = 0
    const f = fixture('evolve-new-mount', 500021, 60, {
        rng: (a, b) => {
            draws++
            return rng(a, b)
        },
    })
    try {
        const old = structuredClone(f.pet()),
            before = draws
        assert(!tables.find('mount', 500021))
        assert(tables.find('mount', 500022))
        f.call('RankUpPet', { u64: f.guid })
        assert.equal(f.pet().config_id, 500022)
        assert.equal(draws - before, 2)
        assert(tables.get('mount_speed').some((r) => f.pet().speed >= r.min && f.pet().speed <= r.max))
        assert.deepEqual(f.pet().comprehension, old.comprehension)
    } finally {
        f.store.close()
    }
})
test('malformed rules use configuration errors and mixed-resource shortages roll back earlier currency spending', () => {
    const f = fixture('evolve-cost-rollback', 500025, 60),
        rule = petEvolutionRule(500025),
        old = rule.rankBreakthroughItem
    try {
        assert.throws(
            () => f.call('RankUpPet', { u64: '18446744073709551615' }),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.gold = 100))
        rule.rankBreakthroughItem = '10#2#50|3#499001#1'
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        rule.rankBreakthroughItem = '3#499001#0'
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        rule.rankBreakthroughItem = old
        f.store.close()
    }
})

test('malformed evolved skill tuples are configuration failures before any ownership or fee mutation', () => {
    const f = fixture('evolve-invalid-skills', 500002, 20),
        config = tables.find('pet', 500003),
        original = config.skillList
    try {
        config.skillList = '1#0#1'
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpPet', { u64: f.guid }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        config.skillList = original
        f.store.close()
    }
})
