import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'

export function noviceEventFixture(name, options) {
    const f = noviceDuelFixture(name, options)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    const actors = () => Object.values(f.state().combat.npcDuel.actors).filter((actor) => actor.camp === 1)
    const summon = (actor, replacement) =>
        f.call('KiboDuelArenaSummonReq', {
            pet_guid: actor.uuid,
            source_pet_guid: actor.source_guid,
            pos: f.state().combat.npcDuel.positions.selfSummon.pos,
            angle: actor.angle,
            ...(replacement ? { replace_kibo_guid: replacement.uuid } : {}),
        })
    const selectTagged = (tag) => {
        edit((s) => {
            const selected = s.pets
                .filter((p) =>
                    String(f.tables.find('pet', p.config_id).kiboDuelTag ?? '')
                        .split('|')
                        .map(Number)
                        .includes(tag),
                )
                .slice(0, 2)
            assert.equal(selected.length, 2, 'Two real current seeded pet instances share the configured tag')
            s.pets = [...selected, ...s.pets.filter((pet) => !selected.includes(pet))]
        })
    }
    return {
        ...f,
        get session() {
            return f.session
        },
        edit,
        actors,
        summon,
        selectTagged,
        enterWithSkill: (skillId) => {
            const configured = f.tables.get('kibo_duel_skill').find((r) => r.skillId === skillId)
            assert(configured)
            const level = f.tables
                .get('kibo_duel_area_level')
                .find((r) => r.areaType === 1 && String(r.kiboDuelSkill).split('|').map(Number).includes(configured.id))
            if (!configured.defaultSkill) {
                assert(level, 'A real area level unlocks this actual trainer skill')
                edit((s) => {
                    ;(s.kiboDuelAreas ??= {})[1] = { id: 1, lvl: level.level, exp: 0, got_lvl_reward: [1] }
                })
            }
            f.call('KiboDuelGetGroup', { u32: 2001 })
            f.call('KiboDuelGroupInfoChange', {
                slot: 1,
                duel_id: 2001,
                hero: f.state().player.heros_info.heros[0].guid,
                pet_guids: f
                    .state()
                    .pets.slice(0, 8)
                    .map((p) => ({ id: p.guid, is_trial: false })),
                hero_skills: [{ skill_id: skillId, skill_lv: 1, skill_slot: 701, type: 1 }],
            })
            f.call('KiboDuelSetCurGroup', { u32: 1 })
            f.call('MultiCampaignCreate', { dungeon_id: f.tables.find('kibo_duel', 2001).dungeonId })
            f.call('StartDungeonClientOk')
            f.call('MultiCampaignPlayerLoadFinish')
            f.call('KiboDuelArenaFirstConfirmReq')
            f.advance(f.state().combat.npcDuel.intro_until - f.now())
            f.tick()
        },
        cast: (skillId, index, sourceType = 1) =>
            f.call('SkillStart', {
                unit_id: f.state().combat.npcDuel.trainer_guid,
                op_time: String(f.now() * 1000),
                skill: { skill_id: skillId, slot: 701 },
                verify_info: { battle_index: String(index), source_type: sourceType },
            }),
    }
}

export function noviceEventFile() {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'novice-events-'))
    return {
        file: path.join(dir, 'state.sqlite'),
        close() {
            const target = path.resolve(dir)
            assert.equal(path.dirname(target), parent)
            assert(path.basename(target).startsWith('novice-events-'))
            fs.rmSync(target, { recursive: true, force: true })
        },
    }
}
