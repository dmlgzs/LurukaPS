import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroModules } from '../src/battle.js'
import { activeFormationManager } from '../src/trial-actors.js'

const config = configuration()
const tables = new Tables(config.tables)
const protocol = new Protocol(config.base)

export function teachingProfileAssets(state) {
    return structuredClone({
        heroes: state.player.heros_info.heros,
        pets: state.pets,
        bag: state.player.sbag_infos,
        souls: state.player.soulessence_infos,
        ornaments: state.ornaments,
    })
}

export function teachingProfileFixture(profile) {
    const store = new Store(':memory:')
    let nowMs = 1800000000000,
        seq = 1,
        elementUid = 950000,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000), arenaClockMs: () => nowMs })
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get(name) ?? protocol.byName.get('CSProto' + name)
        assert(entry, 'Missing current protocol ' + name)
        return { id: entry.id, seq: seq++, payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0) }
    }
    const successfulSkills = new Set()
    const dispatch = (packet) => {
        const result = game.dispatch(session, packet)
        if (packet.id === protocol.byName.get('CSProtoSkillStart').id) {
            const request = protocol.decode(protocol.byId.get(packet.id).req, packet.payload)
            successfulSkills.add(request.unit_id + ':' + request.skill.skill_id)
        }
        return result
    }
    const call = (name, request) => dispatch(frame(name, request))
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'current-profile-' + profile.fsm })
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1)
            .map((row) => ({ task_id: row.id, count: 1 }))
        s.player.basic_info.lv = 60
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
    })
    const initialAssets = teachingProfileAssets(state())
    const entryPackets = call('TeachStart', { id: profile.train })
    assert.equal(state().world.map_id, profile.scenes[0])
    assert.deepEqual(state().storyCampaign.scenes, profile.scenes)
    assert.deepEqual(teachingProfileAssets(state()), initialAssets, 'TeachStart has no configured resource cost')

    const admitTrial = () => {
        const scene = tables.find('dungeon_scene', state().world.map_id)
        const packets = call('TrialGroupChange', { open: true, trial_id: scene.trialsId })
        const trialPacket = protocol.byName.get('CSProtoTrialDatas').id
        const ack = protocol.byName.get('CSProtoTrialGroupChange').id
        assert(packets.findIndex((p) => p.id === trialPacket) >= 0)
        assert(packets.findIndex((p) => p.id === trialPacket) < packets.findIndex((p) => p.id === ack))
        assert.equal(state().trialGroup.current_group_id, scene.trialsId)
        call('StartDungeonClientOk')
        return packets
    }
    const rosterPackets = admitTrial()
    const actor = () => {
        const heroes = state().trialGroup.heroes.filter((hero) => hero.conf_id === profile.hero)
        assert.equal(heroes.length, 1)
        return heroes[0]
    }
    const targets = () => {
        const enemies = state()
            .storyCampaign.scene_objects.filter((row) => row.active)
            .flatMap((row) => row.expand_data?.battle_group?.monsters ?? [])
        assert(enemies.length > 0)
        return enemies
    }
    const skillFrame = (id, index = 0, beginTime = nowMs) => {
        const s = state(),
            hero = actor()
        const published = heroModules(tables, s, hero).modules.flatMap((m) =>
            m.sub_modules.flatMap((sub) => sub.skills?.skills ?? []),
        )
        assert(
            published.some((row) => row.skill_id === id),
            'Actual current trial actor does not publish skill ' + id,
        )
        return frame('SkillStart', {
            unit_id: hero.guid,
            skill: { skill_id: id, index, begin_time: String(beginTime) },
            op_time: String(nowMs),
        })
    }
    const elementFrame = ({
        id,
        operation = 1,
        receiver = 'hero',
        executor = 'hero',
        source: sourceRole,
        creator,
        uid = elementUid++,
    }) => {
        const hero = actor().guid,
            enemy = targets()[0].uid
        const target = receiver === 'enemy' ? enemy : hero
        const source = executor === 'enemy' ? enemy : hero
        const dictionary = [...new Set([target, source, hero, String(uid), String(id)])]
        const ix = (value) => String(dictionary.indexOf(String(value)) + 1)
        return frame('BattleInfoReduce', {
            base_time: String(nowMs),
            uint64_dic: dictionary,
            battle_info: [
                {
                    element_info: {
                        op: operation,
                        tar_id: ix(target),
                        uniqueId: ix(uid),
                        verify_info: { op_time: '0' },
                        buff: {
                            cfg_id: ix(id),
                            begin_time: '0',
                            executor_id: ix(source),
                            attacker_id: ix(hero),
                            ...(sourceRole === 'hero' ? { source_id: ix(hero) } : {}),
                            ...(creator === 'hero' ? { creator_id: ix(hero) } : {}),
                        },
                    },
                },
            ],
        })
    }
    // This is a bounded CLIENT input model, not Native execution or a server
    // damage engine. The141 marker and event occurrence are explicit premises;
    // neither is inserted into server state or forged as a network packet.
    const localImmune423Frame = (input) => {
        if (!input || typeof input !== 'object') return null
        const s = state(),
            hero = actor()
        const passivePublished = heroModules(tables, s, hero).modules.some((module) =>
            module.sub_modules.some((sub) => sub.skills?.skills.some((skill) => skill.skill_id === 10200161)),
        )
        const manager = activeFormationManager(s)
        const control = manager?.groups.find((group) => group.id === manager.cur_group)?.control
        const battle = s.player.heros_info.battle_infos.find((row) => row.hero_id === hero.guid)
        if (
            !passivePublished ||
            input.passive61LocallyInitialized !== true ||
            !successfulSkills.has(hero.guid + ':10200112') ||
            input.trigger110Installed !== true ||
            input.eventType !== 3 ||
            input.ignoreDamageEvent !== false ||
            !Number.isInteger(input.damageType) ||
            [5, 11].includes(input.damageType) ||
            input.selfGuid !== hero.guid ||
            input.sourceGuid !== hero.guid ||
            !targets().some((row) => row.uid === input.targetGuid) ||
            control !== hero.guid ||
            !battle ||
            battle.hp <= 0 ||
            battle.alive_state !== 0 ||
            !Array.isArray(input.localHeroElementIds) ||
            !input.localHeroElementIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
            !input.localHeroElementIds.includes(102001141)
        )
            return null
        // Current type2 checker targets base.source=parent attacker Hero.
        // Trigger110 AND HasElementId141 passes for this explicit premise.
        // Trigger420's other Native branch is outside this bounded model.
        // Effect AllHero15 selects live/main-control; here it is that Hero.
        return elementFrame({ id: 102001423, source: 'hero', creator: 'hero' })
    }
    return {
        tables,
        protocol,
        store,
        game,
        state,
        call,
        frame,
        dispatch,
        actor,
        targets,
        skillFrame,
        elementFrame,
        localImmune423Frame,
        entryPackets,
        rosterPackets,
        initialAssets,
        nowMs: () => nowMs,
        advance: (ms) => {
            assert(Number.isSafeInteger(ms) && ms >= 0)
            nowMs += ms
        },
        proof: () => Object.values(state().combat?.teachingProof ?? {})[0],
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: 'current-profile-' + profile.fsm, reconnect: true })
        },
        nextScene: (id) => {
            call('EnterDungeonScene', { scene_id: id, creator_id: session.id })
            return admitTrial()
        },
        killOrdinaryScene: () => {
            const hero = actor().guid
            for (const enemy of targets()) {
                nowMs++
                call('BattleInfoReduce', {
                    base_time: String(nowMs),
                    uint64_dic: [hero, enemy.uid],
                    battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
                })
                assert.equal(state().combat.entities[enemy.uid].hp, 0)
            }
        },
    }
}
