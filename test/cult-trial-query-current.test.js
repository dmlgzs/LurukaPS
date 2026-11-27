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
import { mainHeroConfigId } from '../src/main-hero.js'
import { temporaryHeroes, temporaryPets, activeFormationManager } from '../src/trial-actors.js'
import { trialPetHydrationDefinition } from '../src/trial-pet-hydration.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    startMs = 1795760400000
function fixture(file = ':memory:', account = 'cult-trial-query-current', existing = false) {
    const protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {}
    let ms = startMs,
        seq = 1,
        draws = 0
    const game = new Game(protocol, store, tables, {
        clock: () => Math.floor(ms / 1000),
        rng: (n) => {
            draws++
            return 0
        },
    })
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const send = (r) =>
        game
            .dispatch(session, r)
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    const call = (name, r = {}) => send(frame(name, r)),
        state = () => store.load(session.id).state,
        g = () => state().activities[60001].growup
    const login = call('EnterGame', { open_id: account })
    if (!existing) {
        // Explicit trusted post-guide qualification, not a played main story. Only
        // the current selected main hero is granted by the canonical resource1
        // writer; no training/exam/accepted receipt/temporary actor is injected.
        store.transact(session.id, 0, (s) => {
            s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
            s.tasks = []
            grantRewards(tables, s, [
                { itemtype: 1, itemid: mainHeroConfigId(tables, s.player.basic_info.sex), itemnum: 1 },
            ])
        })
        call('GetRechargePopupData')
        const hero = state().player.heros_info.heros[0]
        call('QuickChangeGroupInfo', { type: 1, id: 1, infos: [{ hero_guid: hero.guid, pet_guid: '0' }] })
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
        call('EnterWorldMap', { map_id: 200, point_id: 20005 })
        call('EnterWorldMap', { map_id: 101001, point_id: 10100101 })
    }
    const reachExam = () => {
        const phase = g().cur_stage
        let actions = 0
        while (g().cur_growup_trail_stage !== phase) {
            assert(actions++ < 100)
            if (g().cur_cost_expedition_count > 0) call('ActivityGrowUpEventFinishReq', { activity_id: 60001 })
            call('ActivityGrowUpRestReq', { activity_id: 60001 })
        }
        return actions
    }
    return {
        protocol,
        store,
        game,
        session,
        call,
        send,
        frame,
        state,
        g,
        login,
        reachExam,
        draws: () => draws,
        time: () => String(++ms),
        raw: () => store.load(session.id),
        close: () => {
            if (store.db.open) store.close()
        },
    }
}
const request = { u32: 60001 }
function assets(s) {
    return {
        world: s.world,
        playerHeroes: s.player.heros_info,
        ownedPets: s.pets,
        bag: s.player.sbag_infos,
        wallet: s.player.attr_infos,
        nextPet: s.petGuidAllocation,
        nextHero: s.nextHeroGuid,
        eggs: s.petEggs,
        ornaments: s.ornaments,
    }
}
class PreTrialConsumer {
    constructor() {
        this.heroes = new Map()
        this.pets = new Map()
        this.attrs = new Map()
        this.group = null
        this.opened = false
    }
    consume(packets) {
        for (const p of packets) {
            if (p.id === 5001) {
                const manager = p.data.data.group_mgrs?.find((entry) => entry.type === 8)
                if (manager) this.group = manager.groups.find((entry) => entry.id === manager.cur_group) ?? null
            }
            if (p.id === 5988) {
                for (const h of p.data.trial_heros ?? []) this.heroes.set(h.guid, h)
                for (const pet of p.data.trial_pets ?? []) this.pets.set(pet.guid, pet)
            }
            if (p.id === 5008) {
                const m = p.data.group_mgrs?.find((x) => x.type === 8)
                if (m) this.group = m.groups.find((x) => x.id === m.cur_group) ?? null
            }
            if (p.id === 10006)
                for (const actor of p.data.heros ?? []) {
                    if (actor.type === 5)
                        assert(this.heroes.has(actor.hero_guid), 'trial hero base must exist before its attributes')
                    if (actor.type === 9)
                        assert(this.pets.has(actor.hero_guid), 'trial pet base must exist before its attributes')
                    this.attrs.set(actor.hero_guid, actor)
                }
            if (p.id === 5989) {
                assert(this.group)
                assert.equal(this.group.heros.length, 3)
                for (const slot of this.group.heros) {
                    const h = this.heroes.get(slot.hero_id)
                    assert(h)
                    assert(this.pets.has(slot.pet_id))
                    assert(this.attrs.has(slot.hero_id))
                    assert(this.attrs.has(slot.pet_id))
                }
                this.opened = true
            }
        }
    }
}
function checkCustom(prepared) {
    for (const pet of prepared.pets) {
        const id = Number((BigInt(pet.guid) >> 32n) & 0xffffffn),
            d = trialPetHydrationDefinition(tables, id)
        assert.equal(pet.customized_id, id)
        assert.equal(pet.config_id, d.custom.petId)
        assert.equal(pet.lv, d.custom.level)
        assert.deepEqual(pet.comprehension, d.comprehension)
        assert.deepEqual(pet.inherent_skills, d.skills)
        assert.deepEqual(
            pet.gene_infos.map((x) => x.gene_id),
            d.fixedGenes,
        )
    }
}
function winFirstTrial(f) {
    const entered = f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
    assert(entered.some((p) => p.id === 9610))
    f.call('MultiCampaignPlayerLoaded')
    const waves = tables
        .get('game_events_cul_trial_wave')
        .filter((x) => x.trialId === 101)
        .sort((a, b) => a.waveId - b.waveId)
    assert(waves.length > 0)
    for (const wave of waves) {
        const s = f.state(),
            run = s.cultTrial,
            objects = String(wave.worldMapId).split('|').map(Number)
        assert.equal(run.current_wave, wave.waveId)
        const targets = Object.values(s.combat.entities).filter((x) => objects.includes(x.object_id) && x.hp > 0)
        assert(targets.length)
        f.call('BattleInfoReduce', {
            uint64_dic: [run.pets[0].guid, ...targets.map((x) => x.uuid)],
            battle_info: targets.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: f.time(),
        })
        assert.equal(f.state().cultTrial.completed_waves, wave.waveId)
    }
    assert(f.state().cultTrial.battle_complete)
    assert(f.state().cultTrial.star >= 1)
    f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 101 })
    f.call('WorldPoint', { point_id: 0 })
    assert.equal(f.g().cur_stage, 2)
    assert.equal(f.state().world.map_id, 101001)
    return entered
}

test('real start/presentation/nine rest actions→5989 publishes readable type8 and customized trial cache before ACK with no owned or battle side effects', () => {
    const f = fixture()
    try {
        assert.equal(f.reachExam(), 9)
        const before = f.raw(),
            draws = f.draws(),
            seq = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
            packets = f.call('GetTrialGroup', request)
        const consumer = new PreTrialConsumer()
        consumer.consume(packets)
        assert(consumer.opened)
        assert.deepEqual(
            packets.map((p) => p.id),
            [5988, 5008, 10006, 5989],
        )
        assert(!packets.some((p) => [9101, 9103, 10009, 18048].includes(p.id)))
        assert.deepEqual(assets(f.state()), assets(before.state))
        assert.deepEqual(f.g(), before.state.activities[60001].growup)
        assert.equal(f.state().cultTrial, undefined)
        assert.equal(activeFormationManager(f.state()).type, 1)
        const preview = f.state().player.group_mgrs.find((manager) => manager.type === 8)
        assert.equal(Buffer.from(preview.groups[0].group_name, 'base64').toString('utf8'), '考核编队')
        assert.deepEqual(temporaryHeroes(f.state()), [])
        assert.deepEqual(temporaryPets(f.state()), [])
        checkCustom(f.state().cultTrialPreparation)
        const tickBefore = f.raw()
        f.game.tick(f.session.id, f.session)
        assert.deepEqual(f.raw(), tickBefore, 'an idle current exam tick does not change the preparation')
        assert.equal(f.draws(), draws)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), seq)
        // Existing valid type8 ordering/control is retained. This is a persisted
        // preset-layout qualification vector, not an invented current GUI writer.
        f.store.transact(f.session.id, 0, (s) => {
            const m = s.player.group_mgrs.find((x) => x.type === 8),
                g = m.groups[0]
            g.heros.reverse()
            g.control = g.heros[0].hero_id
        })
        const layout = structuredClone(f.state().player.group_mgrs.find((x) => x.type === 8)),
            prepared = structuredClone(f.state().cultTrialPreparation)
        f.call('GetTrialGroup', request)
        const stable = f.raw(),
            changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        consumer.consume(f.call('GetTrialGroup', request))
        assert.deepEqual(
            f.state().player.group_mgrs.find((x) => x.type === 8),
            layout,
        )
        assert.deepEqual(f.state().cultTrialPreparation, prepared)
        assert.deepEqual(f.raw(), stable)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
    } finally {
        f.close()
    }
})

test('preview GUIDs cannot fight, mount, evolve, feed, bind to an owned hero or receive permanent gifts', () => {
    const f = fixture()
    try {
        f.reachExam()
        const packets = f.call('GetTrialGroup', request),
            p = f.state().cultTrialPreparation,
            hero = p.heroes[0],
            pet = p.pets[0],
            owned = f.state().player.heros_info.heros[0]
        const skill = packets
            .find((x) => x.id === 10006)
            .data.heros.find((x) => x.hero_guid === hero.guid)
            .modules.flatMap((m) => m.sub_modules)
            .flatMap((m) => m.skills?.skills ?? [])[0].skill_id
        const gift = tables.get('hero_favorability_gift').find((x) => tables.find('common_item', x.id)?.type === 110)
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(tables, s, [{ itemtype: 3, itemid: gift.id, itemnum: 1 }]),
        )
        const before = f.raw()
        const rejected = [
            ['SkillStart', { unit_id: hero.guid, skill: { skill_id: skill }, op_time: f.time() }],
            [
                'SkillStart',
                {
                    unit_id: pet.guid,
                    skill: { skill_id: pet.inherent_skills[0].skill_id },
                    op_time: f.time(),
                },
            ],
            ['WearPet', { hero_guid: owned.guid, pet_guid: pet.guid }],
            ['RankUpPet', { u64: pet.guid }],
            [
                'LvUpComprehension',
                {
                    pet_id: pet.guid,
                    items: [
                        {
                            item_id: tables.get('pet_feed_item').find((row) => row.type === 1 && row.isReuse === 1).id,
                            item_num: 1,
                        },
                    ],
                },
            ],
            ['WorldMapPlayerStatus', { status: 1, arg: pet.guid }],
            ['UseGeneFruitReq', { pet_id: pet.guid, item_id: 1750001, slot_pos: 0 }],
            ['PetSetRoulettePos', { guid: pet.guid, pos: 1 }],
            ['SendHeroGift', { heroId: hero.conf_id, item_id: gift.id, item_type: 110, num: 1 }],
        ]
        for (const [name, data] of rejected) {
            assert(
                f.game.handlers.has(f.protocol.byName.get('CSProto' + name).id),
                'negative control must reach an implemented handler: ' + name,
            )
            const entry = f.protocol.byName.get('CSProto' + name),
                wire = f.protocol.decode(entry.req, f.protocol.encode(entry.req, data))
            const targetField = {
                SkillStart: 'unit_id',
                WearPet: 'pet_guid',
                RankUpPet: 'u64',
                LvUpComprehension: 'pet_id',
                WorldMapPlayerStatus: 'arg',
                UseGeneFruitReq: 'pet_id',
                PetSetRoulettePos: 'guid',
                SendHeroGift: 'heroId',
            }[name]
            assert.equal(
                String(wire[targetField]),
                String(data[targetField]),
                name + ' target must survive the actual codec',
            )
            if (name === 'LvUpComprehension') assert.deepEqual(wire.items, data.items)
            const expectedCode = {
                SkillStart: ErrorCode.InvalidArgument,
                WearPet: ErrorCode.InvalidArgument,
                RankUpPet: ErrorCode.PetNotExist,
                LvUpComprehension: ErrorCode.PetNotExist,
                WorldMapPlayerStatus: ErrorCode.VehicleNotOwned,
                UseGeneFruitReq: ErrorCode.PetNotExist,
                PetSetRoulettePos: ErrorCode.InvalidArgument,
                SendHeroGift: ErrorCode.HeroNotExist,
            }[name]
            assert.throws(
                () => f.call(name, data),
                (error) => error.code === expectedCode,
                name,
            )
            assert.deepEqual(f.raw(), before, name)
        }
        let error
        try {
            f.call('BattleInfoReduce', {
                uint64_dic: [pet.guid, owned.guid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
                base_time: f.time(),
            })
        } catch (e) {
            error = e
        }
        assert.deepEqual(assets(f.state()), assets(before.state))
        assert.equal(f.state().combat?.skills?.[hero.guid], undefined)
        assert.equal(f.state().combat?.skills?.[pet.guid], undefined)
        assert.equal(
            f.state().pets.some((x) => x.guid === pet.guid),
            false,
        )
        assert.equal(
            f.state().player.heros_info.heros.some((x) => x.guid === hero.guid),
            false,
        )
        assert(error || !f.state().combat?.entities?.[pet.guid], 'a preview damage report has no accepted actor/effect')
    } finally {
        f.close()
    }
})

test('the same preview roster moves into a real101 victory, clears on return, then actual next-exam actions establish stage2 without reset or fake receipts', () => {
    const f = fixture()
    try {
        f.reachExam()
        f.call('GetTrialGroup', request)
        const preview = structuredClone(f.state().cultTrialPreparation),
            ownedBefore = structuredClone(f.state().player.heros_info.heros)
        // This existing valid order/control is not overwritten by adopting the UI roster.
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.player.group_mgrs.find((x) => x.type === 8).groups[0]
            g.heros.reverse()
            g.control = g.heros[0].hero_id
        })
        const layout = structuredClone(f.state().player.group_mgrs.find((x) => x.type === 8))
        const enter = f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
        assert.equal(f.state().cultTrialPreparation, undefined)
        assert.deepEqual(
            f.state().cultTrial.heroes.map((x) => x.guid),
            preview.heroes.map((x) => x.guid),
        )
        assert.deepEqual(
            f.state().cultTrial.pets.map((x) => x.guid),
            preview.pets.map((x) => x.guid),
        )
        assert.deepEqual(
            f.state().player.group_mgrs.find((x) => x.type === 8),
            layout,
        )
        checkCustom(f.state().cultTrial)
        assert(enter.findIndex((p) => p.id === 5988) < enter.findIndex((p) => p.id === 10006))
        // Re-enter uses the existing live run, then follows every current wave.
        winFirstTrial(f)
        assert.equal(f.state().cultTrialPreparation, undefined)
        assert.equal(f.state().cultTrial, undefined)
        assert.equal(
            f.state().player.group_mgrs.some((x) => x.type === 8),
            false,
        )
        assert.deepEqual(f.state().player.heros_info.heros, ownedBefore)
        const before = f.raw()
        assert.throws(
            () => f.call('GetTrialGroup', request),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        assert.deepEqual(f.raw(), before)
        assert.equal(f.reachExam(), 12)
        const packets = f.call('GetTrialGroup', request)
        new PreTrialConsumer().consume(packets)
        assert.equal(f.state().cultTrialPreparation.stage, 2)
        assert.equal(f.state().cultTrialPreparation.run_guid, preview.run_guid)
        const receipt = `${preview.run_guid}:101`
        assert.equal(f.state().acceptedCultTrials[receipt], true)
        const run = structuredClone(f.g()),
            assetsBefore = structuredClone(assets(f.state()))
        f.call('QuitPhotoGraphScene')
        assert.equal(f.state().cultTrialPreparation, undefined)
        assert.equal(
            f.state().player.group_mgrs.some((x) => x.type === 8),
            false,
        )
        assert.deepEqual(f.g(), run)
        assert.deepEqual(f.state().player.heros_info.heros, assetsBefore.playerHeroes.heros)
        assert.equal(f.state().acceptedCultTrials[receipt], true)
    } finally {
        f.close()
    }
})

test('5989 requires a current active ready exam and its scene; unavailable60002/unknown IDs never synthesize a roster', () => {
    const f = fixture()
    try {
        let before = f.raw()
        assert.throws(
            () => f.call('GetTrialGroup', request),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        assert.deepEqual(f.raw(), before)
        f.reachExam()
        for (const u32 of [0, 60002, 4294967295]) {
            before = f.raw()
            assert.throws(() => f.call('GetTrialGroup', { u32 }))
            assert.deepEqual(f.raw(), before)
        }
        f.call('GetTrialGroup', request)
        f.call('QuitPhotoGraphScene')
        before = f.raw()
        assert.throws(
            () => f.call('GetTrialGroup', request),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        assert.deepEqual(f.raw(), before)
        f.call('EnterWorldMap', { map_id: 101001, point_id: 10100101 })
        f.call('GetTrialGroup', request)
        const owned = structuredClone(assets(f.state())),
            book = structuredClone(f.g().end_data)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        assert.equal(f.state().cultTrialPreparation, undefined)
        assert.equal(
            f.state().player.group_mgrs.some((manager) => manager.type === 8),
            false,
        )
        assert.deepEqual(f.g().end_data, book)
        assert.deepEqual(f.state().pets, owned.ownedPets)
    } finally {
        f.close()
    }
})

test('partial publication codec and late SQLite failures roll back the whole preparation; cold login keeps the cache and strict source binding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-cult-query-')),
        file = path.join(dir, 'state.sqlite'),
        account = 'cult-query-cold'
    let f = fixture(file, account),
        original = f.protocol.encode.bind(f.protocol)
    try {
        f.reachExam()
        const before = f.raw(),
            seq = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(10006).rsp) throw Error('cult query codec')
            return original(name, data)
        }
        assert.throws(() => f.call('GetTrialGroup', request), /cult query codec/)
        f.protocol.encode = original
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), seq)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_cult_query BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'cult query SQL'); END",
        )
        assert.throws(() => f.call('GetTrialGroup', request), /cult query SQL/)
        f.store.db.exec('DROP TRIGGER reject_cult_query')
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), seq)
        const consumer = new PreTrialConsumer()
        consumer.consume(f.call('GetTrialGroup', request))
        const prepared = structuredClone(f.state().cultTrialPreparation),
            layout = structuredClone(f.state().player.group_mgrs.find((x) => x.type === 8)),
            owned = structuredClone(assets(f.state()))
        f.close()
        f = fixture(file, account, true)
        const cold = new PreTrialConsumer()
        cold.consume(f.login)
        cold.consume(f.call('GetTrialGroup', request))
        assert(cold.opened)
        assert.deepEqual(f.state().cultTrialPreparation, prepared)
        assert.deepEqual(
            f.state().player.group_mgrs.find((x) => x.type === 8),
            layout,
        )
        assert.deepEqual(assets(f.state()), owned)
        // These are isolated corrupt-save vectors; no production history/asset is
        // erased to make them pass, and failed cold normalization leaves SQL exact.
        f.store.transact(f.session.id, 0, (s) => {
            s.cultTrialPreparation.fingerprint = '0'.repeat(64)
        })
        const broken = f.raw()
        assert.throws(
            () => f.call('GetTrialGroup', request),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.raw(), broken)
        assert.throws(
            () => f.game.dispatch({}, f.frame('EnterGame', { open_id: account })),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.raw(), broken, 'cold normalization of a stale source cannot partly save')
        f.store.transact(f.session.id, 0, (state) => {
            state.cultTrialPreparation = null
        })
        const nullLedger = f.raw()
        assert.throws(
            () => f.call('GetTrialGroup', request),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.raw(), nullLedger)
    } finally {
        f.protocol.encode = original
        f.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
