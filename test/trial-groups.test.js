import { populateParty } from './party-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { repairTrialActorGuids } from '../src/handlers/trial-groups.js'
import { mainHeroConfigId } from '../src/main-hero.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { currentSceneTrialRoster } from '../src/current-scene-trials.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    graphs = new TaskGraphs(tables),
    now = 1800000000,
    boss = ((3n << 56n) | 600003n).toString()
function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    let session = {},
        seq = 1,
        ms = now * 1000
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, {
                id: e.id,
                seq: seq++,
                payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
            })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    call('EnterGame', { open_id: name })
    edit(populateParty)
    return {
        store,
        game,
        call,
        state,
        edit,
        id: () => session.id,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        hit: (from, target, amount) =>
            call('BattleInfoReduce', {
                base_time: String(++ms),
                uint64_dic: from ? [from, target] : [target],
                battle_info: [
                    { hurt_info: { ...(from ? { from_id: '1' } : {}), tar_id: from ? '2' : '1', hp_change: -amount } },
                ],
            }),
        timestamp: () => String(++ms),
        close: () => store.close(),
    }
}
const manager = (s) => activeFormationManager(s)
const active = (s) => {
    const m = manager(s)
    return m.groups.find((g) => g.id === m.cur_group)
}
const saved = (s) => manager(s).groups.find((g) => g.id === 1)
const info = (s, guid) => s.player.heros_info.battle_infos.find((h) => h.hero_id === guid)
const trialDataId = protocol.byName.get('CSProtoTrialDatas').id
function checkpoint(f, taskId, nodeId, map = 102) {
    f.edit((s) => {
        // Explicit trusted progress fixture, not a simulated completion receipt.
        Object.assign(s.world, tables.position(tables.find('world_borthpos', map === 102 ? 10201 : 10401)))
        const graph = graphs.get(taskId)
        s.tasks = [
            {
                task_id: taskId,
                nodes: [makeNode(graph, nodeId, s)],
                finish_nodes: taskId === 106002 && nodeId === 59 ? [1, 56, 65, 61, 58, 63, 62, 57] : [graph.start],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        s.taskRecords = taskId === 106002 ? [{ task_id: 106001, count: 1, time: now - 1 }] : []
        s.taskEpochs[taskId] = 1
        delete s.pendingTaskStorySync
        delete s.pendingTaskScene
    })
}
function bossSource(f) {
    checkpoint(f, 106002, 59)
    f.call('TrialGroupChange', { open: true, trial_id: 2 })
    f.call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
    f.call('MultiCampaignPlayerLoaded')
    f.call('TryCreateWorldObj', { objs: [boss] })
    f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
}
function ackThenActors(packets) {
    const ack = packets.findIndex((p) => p.id === 5987),
        attrs = packets.findIndex((p) => p.id === 10006),
        actors = packets.findIndex((p) => p.id === trialDataId)
    assert(ack >= 0 && attrs > ack && actors > attrs)
    assert(packets.findIndex((p) => p.id === 5008 && p.data.group_mgrs?.length) > actors)
}

test('actual formal prologue controller opens trial1, preserves combat HP across reconnect and restores owned formation', () => {
    const f = fixture('trial-current-formal1')
    try {
        checkpoint(f, 106001, 5)
        const original = structuredClone(manager(f.state())),
            owned = structuredClone(f.state().player.heros_info.heros),
            request = { open: true, trial_id: 1 },
            packets = f.call('TrialGroupChange', request)
        ackThenActors(packets)
        const hero = f.state().trialGroup.heroes[0]
        assert.equal(hero.conf_id, 107001)
        assert.equal(hero.hero_lv, 1)
        assert(hero.trail)
        assert.equal(BigInt(hero.guid) >> 56n, 5n)
        assert.equal((BigInt(hero.guid) >> 32n) & 0xffffffn, 107001n)
        assert.equal(manager(f.state()).cur_group, 0)
        assert.equal(active(f.state()).control, hero.guid)
        assert.equal(manager(f.state()).src, 0)
        const attrs = packets.find((p) => p.id === 10006).data.heros.find((h) => h.hero_guid === hero.guid)
        assert.equal(attrs.type, 5)
        assert(
            attrs.modules.some((m) =>
                m.sub_modules.some((sub) => sub.skills.skills.some((skill) => skill.skill_id === 10700113)),
            ),
        )
        const oldControl = original.groups.find((g) => g.id === original.cur_group).control,
            pos = structuredClone(f.state().world.pos)
        f.call('SwitchWorldGroupControl', { type: 1, control: oldControl, pos: {}, switch_type: 56 })
        f.call('SwitchGroupControlEnd', { uuid: oldControl })
        assert.equal(active(f.state()).control, hero.guid)
        assert.deepEqual(f.state().world.pos, pos)
        const enemy = ((4n << 56n) | 10600101n).toString()
        assert(f.hit(hero.guid, enemy, 10).some((p) => p.id === 10706))
        assert.equal(f.state().combat.entities[enemy].config_id, 310624)
        assert.equal(f.state().combat.entities[enemy].hp, f.state().combat.entities[enemy].max_hp - 10)
        const hp = info(f.state(), hero.guid).hp
        f.hit(null, hero.guid, 1)
        assert.equal(info(f.state(), hero.guid).hp, hp - 1)
        f.call('TrialGroupChange', request)
        assert.equal(f.state().trialGroup.previous_group, original.cur_group)
        assert(f.reconnect().some((p) => p.id === trialDataId))
        assert.equal(info(f.state(), hero.guid).hp, hp - 1)
        const before = f.state()
        assert.throws(() => f.call('TrialGroupChange', { open: true, trial_id: 3 }), /not admitted/)
        assert.deepEqual(f.state(), before)
        f.call('TrialGroupChange', { open: false })
        assert.equal(f.state().trialGroup, undefined)
        assert.deepEqual(manager(f.state()), original)
        assert.deepEqual(f.state().player.heros_info.heros, owned)
        assert(!info(f.state(), hero.guid))
        f.call('TrialGroupChange', request)
        // Trusted saved-scene boundary, followed by a normal RPC reconciliation.
        f.edit((s) => {
            s.world.map_id = 100
        })
        f.call('WorldTimeSync', { world_time: 43200 })
        assert.equal(f.state().trialGroup, undefined)
        checkpoint(f, 106001, 5)
        f.call('TrialGroupChange', request)
        f.edit((s) => {
            s.tasks[0].nodes = [makeNode(graphs.get(106001), 63, s)]
        })
        f.reconnect()
        assert.equal(f.state().trialGroup, undefined)
        assert.deepEqual(manager(f.state()), original)
    } finally {
        f.close()
    }
})

test('actual formal node56 template2 replaces one slot in a saved-party copy and restores it afterward', () => {
    const f = fixture('trial-current-mixed2')
    try {
        checkpoint(f, 106002, 56)
        const original = structuredClone(saved(f.state())),
            packets = f.call('TrialGroupChange', { open: true, trial_id: 2 })
        ackThenActors(packets)
        const s = f.state(),
            group = active(s),
            hero = s.trialGroup.heroes[0]
        assert.equal(group.heros.length, 3)
        assert.equal(group.heros[0].hero_id, original.heros[0].hero_id)
        assert.equal(group.heros[1].hero_id, original.heros[1].hero_id)
        assert.equal(group.heros[2].hero_id, hero.guid)
        assert.equal(group.control, hero.guid)
        assert.equal(s.trialGroup.force, false)
        assert.equal(s.trialGroup.current_group_id, 2)
        assert.deepEqual(saved(s), original)
        f.call('TrialGroupChange', { open: false })
        assert.equal(manager(f.state()).cur_group, 1)
        assert.deepEqual(saved(f.state()), original)
        assert(!manager(f.state()).groups.some((g) => g.id === 0))
    } finally {
        f.close()
    }
})

test('published node59 FSM template3 binds Abi102 to Sif, supports combat, removal and stale-pet filtering', () => {
    const f = fixture('trial-current-abi3')
    try {
        f.edit((s) => {
            saved(s).heros[1].pet_id = s.pets[0].guid
        })
        const original = structuredClone(saved(f.state())),
            ownedPets = structuredClone(f.state().pets)
        bossSource(f)
        const packets = f.call('TrialGroupChange', { open: true, trial_id: 3 }),
            s = f.state(),
            hero = s.trialGroup.heroes[0],
            pet = s.trialGroup.pets[0]
        ackThenActors(packets)
        assert.equal(pet.config_id, 500264)
        assert.equal(pet.type, 2)
        assert.equal(BigInt(pet.guid) >> 56n, 9n)
        assert.equal((BigInt(pet.guid) >> 32n) & 0xffffffn, 102n)
        assert.equal(pet.hero_id, hero.guid)
        assert.equal(hero.trial_pet, pet.guid)
        assert.equal(active(s).control, hero.guid)
        assert(active(s).heros.some((h) => h.hero_id === hero.guid && h.pet_id === pet.guid))
        assert.equal(active(s).heros[1].pet_id, original.heros[1].pet_id)
        assert.deepEqual(saved(s), original)
        assert.deepEqual(s.pets, ownedPets)
        // Pure legacy-ID repair boundary. Current connection-scoped FSM
        // admission is re-established separately by the reconnect test below.
        const legacy = structuredClone(s),
            oldPetGuid = ((9n << 56n) | (BigInt(0x800000 + 102) << 32n) | BigInt(f.id())).toString(),
            legacySlot = active(legacy).heros.find((h) => h.pet_id === pet.guid)
        legacySlot.pet_id = oldPetGuid
        legacy.trialGroup.pets[0].guid = oldPetGuid
        legacy.combat.skills[oldPetGuid] = { skill: { skill_id: 50026401 } }
        assert.equal(repairTrialActorGuids(tables, legacy), true)
        assert.equal(legacy.trialGroup.pets[0].guid, pet.guid)
        assert.equal(legacy.combat.skills[oldPetGuid], undefined)
        assert.equal(active(legacy).heros.find((h) => h.hero_id === hero.guid).pet_id, pet.guid)
        assert.deepEqual(legacy.pets, ownedPets)
        assert.equal(repairTrialActorGuids(tables, legacy), false)
        assert.deepEqual(Object.fromEntries(pet.comprehension.map((c) => [c.attr_id, c.value])), {
            1: 120,
            3: 130,
            5: 130,
            230: 120,
            229: 120,
            7: 400,
        })
        assert(packets.some((p) => p.id === trialDataId && p.data.trial_pets.some((v) => v.guid === pet.guid)))
        assert.equal(packets.find((p) => p.id === 10006).data.heros.find((v) => v.hero_guid === pet.guid).type, 9)
        assert.equal(f.call('SkillFailVec', { unit_id: pet.guid })[0].data.success, true)
        assert.equal(f.call('SwitchPetAction', { uuid: pet.guid, type: 1 })[0].id, 11062)
        f.call('TrialGroupChange', { open: true, trial_id: 3 })
        assert.deepEqual(f.state().trialGroup.pets[0], pet)
        f.call('SkillEffectDone', { uuid: boss, skill_id: 40001128 })
        f.call('ShieldInfo', { uuid: boss, shield: [{ id: 1, val: 109 }] })
        assert.equal(f.state().combat.shields[boss][0].val, 109)
        f.call('ShieldInfoDel', { uuid: boss, shield_id: [1] })
        assert.equal(f.state().combat.shields[boss], undefined)
        f.hit(pet.guid, boss, 10)
        assert.equal(f.state().combat.entities[boss].hp, f.state().combat.entities[boss].max_hp - 10)
        f.call('TrialGroupChange', { open: false })
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        assert.equal(f.state().trialGroup.pets.length, 0)
        assert.equal(f.state().trialGroup.heroes[0].trial_pet, '0')
        assert.deepEqual(f.call('SkillStart', { unit_id: pet.guid, skill: { skill_id: 536018 } }), [])
        assert.deepEqual(f.call('SkillFailVec', { unit_id: pet.guid }), [])
        assert.deepEqual(f.call('SwitchPetAction', { uuid: pet.guid, type: 1 }), [])
        const living = original.heros[0].hero_id,
            hp = info(f.state(), living).hp
        f.call('BattleInfoReduce', {
            base_time: f.timestamp(),
            uint64_dic: [pet.guid, living, boss, '8082234599', '400011215'],
            battle_info: [
                { element_info: { op: 1, tar_id: '1', uniqueId: '4', buff: { cfg_id: 5, creator_id: '3' } } },
                { hurt_info: { from_id: '3', tar_id: '2', hp_change: -1 } },
            ],
        })
        assert.equal(info(f.state(), living).hp, hp - 1)
        assert.equal(f.state().combat.elements['8082234599'], undefined)
        f.call('TrialGroupChange', { open: true, trial_id: 3 })
        assert.equal(f.state().trialGroup.pets.length, 1)
        assert.equal(f.call('SkillFailVec', { unit_id: pet.guid })[0].data.success, true)
        assert.throws(
            () =>
                f.call('SkillStart', {
                    unit_id: ((9n << 56n) | (999n << 32n) | BigInt(f.id())).toString(),
                    skill: { skill_id: 536018 },
                }),
            /not active/,
        )
        f.hit(pet.guid, boss, 2147483647)
        assert.equal(f.state().combat.entities[boss].hp, 0)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        f.call('TrialGroupChange', { open: false })
        assert.deepEqual(saved(f.state()), original)
        assert.deepEqual(f.state().pets, ownedPets)
    } finally {
        f.close()
    }
})

test('login repairs a legacy one-person mixed trial party without changing its saved owned formation', () => {
    const f = fixture('trial-current-mixed-migration')
    try {
        checkpoint(f, 106002, 56)
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        const original = structuredClone(saved(f.state())),
            oldHero = ((1n << 56n) | (BigInt(0x800000 + 107001) << 32n) | BigInt(f.id())).toString(),
            guid = f.state().trialGroup.heroes[0].guid,
            hp = info(f.state(), guid).hp
        f.edit((s) => {
            const trial = active(s)
            trial.heros = [{ hero_id: oldHero, pet_id: '0' }]
            trial.control = oldHero
            s.trialGroup.heroes[0].guid = oldHero
            info(s, guid).hero_id = oldHero
            s.combat ??= { map_id: 102, skills: {}, bullets: {}, entities: {} }
            s.combat.skills ??= {}
            s.combat.skills[oldHero] = [123]
            delete s.trialGroup.force
            delete s.trialGroup.heroSlots
        })
        f.reconnect()
        const s = f.state()
        assert.equal(active(s).heros.length, 3)
        assert.equal(s.trialGroup.heroes[0].guid, guid)
        assert.equal(BigInt(guid) >> 56n, 5n)
        assert.equal(info(s, guid).hp, hp)
        assert.equal(s.combat.skills[oldHero], undefined)
        assert.deepEqual(saved(s), original)
        assert(active(s).heros.some((h) => h.hero_id === guid))
    } finally {
        f.close()
    }
})

test('reconnect re-establishes the actual FSM source and current template3 repeats without duplicate actors', () => {
    const f = fixture('trial-current-reconnect3')
    try {
        bossSource(f)
        const request = { open: true, trial_id: 3 }
        f.call('TrialGroupChange', request)
        const old = f.state().trialGroup,
            owned = structuredClone(f.state().pets)
        f.reconnect()
        // A new connection has a new AOI lifetime. Recreate its real current
        // source instead of carrying a stale published lease into template3.
        f.call('MultiCampaignPlayerLoaded')
        f.call('TryCreateWorldObj', { objs: [boss] })
        const packets = f.call('TrialGroupChange', request)
        ackThenActors(packets)
        const s = f.state(),
            hero = s.trialGroup.heroes[0],
            pet = s.trialGroup.pets[0]
        assert.equal(s.trialGroup.pets.length, 1)
        assert.equal(hero.guid, old.heroes[0].guid)
        assert.equal(pet.guid, old.pets[0].guid)
        assert.equal(packets.find((p) => p.id === trialDataId).data.trial_heros[0].trial_pet, pet.guid)
        assert.equal(pet.hero_id, hero.guid)
        assert.deepEqual(f.call('SkillStart', { unit_id: hero.guid, skill: { skill_id: 10700161 } }), [])
        f.hit(hero.guid, boss, 10)
        assert(f.state().combat.entities[boss].hp < f.state().combat.entities[boss].max_hp)
        f.call('TrialGroupChange', request)
        assert.equal(f.state().trialGroup.pets.length, 1)
        assert.deepEqual(f.state().pets, owned)
        const before = f.state()
        assert.throws(
            () =>
                f.call('TrialGroupChange', {
                    ...request,
                    trial_pets: [
                        { id: 102, pos: 1 },
                        { id: 102, pos: 1 },
                    ],
                }),
            /cannot supply/,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('dungeon6207 publishes its current table-defined forced formation before the loading-completion ACK', () => {
    const f = fixture('trial-current-dungeon6207')
    try {
        f.edit((s) => {
            s.player.basic_info.lv = 20
            s.world.map_id = 100
            s.taskEpochs[107016] = 1
            s.tasks = [
                {
                    task_id: 107016,
                    nodes: [{ node_id: 34, node_values: [0], client_before: true }],
                    finish_nodes: [26, 32, 33],
                    reward_nodes: [],
                },
            ]
            s.taskRecords = tables
                .get('task')
                .filter((row) => row.type === 1 && row.id !== 107016)
                .map((row) => ({ task_id: row.id, count: 1, time: now - 1 }))
            s.taskSceneReceipts['107016:1:34'] = true
            delete s.pendingTaskStorySync
            delete s.pendingTaskScene
        })
        f.call('CampaignCreate', { group_id: 219, difficulty: 1 })
        assert.equal(f.state().world.map_id, 6207)
        const original = structuredClone(saved(f.state())),
            roster = currentSceneTrialRoster(tables, 6207)
        assert.equal(roster.groupId, 6207)
        assert.deepEqual(
            roster.heroes.map((h) => h.id),
            [1070161, 1070162, 1070163],
        )
        const request = { open: true, trial_id: roster.groupId }
        const ready = (packets) => {
            const ack = packets.findIndex((p) => p.id === 5987)
            for (const id of [trialDataId, 10006, 10009]) {
                const index = packets.findIndex((p) => p.id === id)
                assert(index >= 0 && index < ack)
            }
            const groupPacket = packets.findIndex((p) => p.id === 5008 && p.data.group_mgrs?.length)
            assert(groupPacket >= 0 && groupPacket < ack)
            const trial = packets.find((p) => p.id === trialDataId).data.trial_heros
            assert.equal(trial.length, 3)
            assert.equal(trial[0].conf_id, mainHeroConfigId(tables, f.state().player.basic_info.wardrobe.sex))
            const group = packets[groupPacket].data.group_mgrs.find((m) => m.type === 1).groups.find((g) => g.id === 0)
            assert.deepEqual(
                group.heros.map((h) => h.hero_id),
                trial.map((h) => h.guid),
            )
            assert.equal(group.control, trial[0].guid)
            for (const hero of trial)
                assert(packets.find((p) => p.id === 10009).data.infos.find((i) => i.uuid === hero.guid).hp > 0)
        }
        ready(f.call('TrialGroupChange', request))
        const protagonist = f.state().trialGroup.heroes[0].guid
        f.call('SwitchGroupControlEnd', { uuid: protagonist })
        assert.equal(f.state().world.control_ready, protagonist)
        const before = info(f.state(), protagonist).hp
        f.hit(null, protagonist, 10)
        assert.equal(info(f.state(), protagonist).hp, before - 10)
        ready(f.call('TrialGroupChange', request))
        assert.equal(info(f.state(), protagonist).hp, before - 10)
        assert.deepEqual(saved(f.state()), original)
        const packets = f.call('TrialGroupChange', { open: false }),
            ack = packets.findIndex((p) => p.id === 5987),
            group = packets.findIndex((p) => p.id === 5008 && p.data.group_mgrs?.length)
        assert(group >= 0 && group < ack)
        assert.equal(f.state().trialGroup, undefined)
    } finally {
        f.close()
    }
})

test('main-avatar trial config matches both sexes clothing animation maps and repairs old male prototypes without changing actor or HP', () => {
    const interim = tables.find('hero_interim', 1070161),
        clothing = tables.find('clothing_item', 10001)
    assert.equal(interim.heroType, 1)
    assert.equal(interim.heroId, 199002)
    for (const sex of [1, 2]) {
        const state = seedPlayer(tables, 1, 'trial-main-sex-' + sex)
        state.player.basic_info.sex = sex
        state.player.basic_info.wardrobe.sex = sex
        const guid = ((5n << 56n) | (1070161n << 32n) | 1n).toString()
        state.trialGroup = {
            ids: [1070161],
            heroes: [{ guid, conf_id: interim.heroId, hero_lv: interim.level, type: interim.heroType }],
            pets: [],
            previous_group: 1,
            force: true,
        }
        const manager = state.player.group_mgrs.find((m) => m.type === 1)
        manager.cur_group = 0
        manager.groups.push({ id: 0, heros: [{ hero_id: guid, pet_id: '0' }], control: guid })
        state.player.heros_info.battle_infos.push({ hero_id: guid, hp: 123, sp: 17, alive_state: 0 })
        const before = structuredClone({
            owned: state.player.heros_info.heros,
            battle: state.player.heros_info.battle_infos,
            groups: manager.groups,
            wardrobe: state.player.basic_info.wardrobe,
        })
        assert.equal(repairTrialActorGuids(tables, state), sex === 2)
        const hero = state.trialGroup.heroes[0]
        assert.equal(hero.conf_id, mainHeroConfigId(tables, sex))
        assert.equal(hero.guid, guid)
        const paths = new Map(
            String(sex === 1 ? clothing.clothingAstM : clothing.clothingAstF)
                .split('|')
                .map((entry) => entry.split('#')),
        )
        assert.ok(
            paths.get(String(hero.conf_id)),
            'the client clothing animator lookup must have a nonempty path for this hero/sex',
        )
        assert.deepEqual(
            {
                owned: state.player.heros_info.heros,
                battle: state.player.heros_info.battle_infos,
                groups: manager.groups,
                wardrobe: state.player.basic_info.wardrobe,
            },
            before,
        )
        assert.equal(repairTrialActorGuids(tables, state), false)
    }
})
