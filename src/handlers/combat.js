import { enemyDefinition } from '../enemy-state.js'
import { recordGuidedKill } from '../task-kills.js'
import { finishEnemyGroupRelations, pruneInactiveCampaignRelations } from './world-combat.js'
import { isPlayerDamageSource } from '../damage-owner.js'
import { advanceEntrustCombat } from './entrust.js'
import { settleStoryCampaignScene } from './story-campaign.js'
import { isRetiredTrialActor } from '../trial-actors.js'
import { ensure } from './common.js'
import { heroModules, heroBattleLimits, heroBattleConfig, petModules, pairs } from '../battle.js'
import { u64, expandBattleReport, combatState, boundedSet } from '../combat-state.js'
export function actor(c, value) {
    const id = u64(value)
    ensure(id !== '0', 'Missing combat actor')
    const kind = Number(BigInt(id) >> 56n)
    if (kind === 1)
        ensure(
            c.state.player.heros_info.heros.some((h) => h.guid === id),
            'Hero not owned',
        )
    if (kind === 5)
        ensure(
            (c.state.trialGroup?.heroes ?? []).some((h) => h.guid === id),
            'Trial hero not active',
        )
    if (kind === 2)
        ensure(
            c.state.pets.some((p) => p.guid === id),
            'Pet not owned',
        )
    if (kind === 9)
        ensure(
            (c.state.trialGroup?.pets ?? []).some((p) => p.guid === id),
            'Trial pet not active',
        )
    return id
}
const itemSkillCatalogs = new WeakMap()
function isFormationPassive(c, skillId) {
    const manager = c.state.player.group_mgrs.find((m) => m.type === 1),
        formation = manager?.groups.find((g) => g.id === manager.cur_group)
    const active = new Set((formation?.heros ?? []).map((h) => h.hero_id))
    return [...c.state.player.heros_info.heros, ...(c.state.trialGroup?.heroes ?? [])].some(
        (hero) =>
            active.has(hero.guid) &&
            String(c.tables.find('hero', hero.conf_id)?.passiveSkillList ?? '')
                .split('|')
                .map(Number)
                .includes(skillId),
    )
}
function skillActorKey(c, request, skillId, stopping = false) {
    if (u64(request.unit_id) !== '0') return actor(c, request.unit_id)
    let skills = itemSkillCatalogs.get(c.tables)
    if (!skills) {
        skills = new Set(c.tables.get('battlefield_item').flatMap((item) => [...pairs(item.skillList).values()]))
        itemSkillCatalogs.set(c.tables, skills)
    }
    // Scene battle items can have selfId=0. Match the configured item skill,
    // then track its cast by verify index, never by the player's current hero.
    const passive = isFormationPassive(c, skillId)
    ensure(skills.has(skillId) || passive, 'Missing combat actor')
    const verify = request.verify_info
    // Battle.proto SkillVerifyType describes the trigger (skill, effect,
    // bullet, behavior, etc.), not actor ownership. Chained item casts use
    // Skill=1 and related_index; source_id is provenance, not a unit GUID.
    const sourceType = verify?.source_type ?? 0
    ensure(
        verify && Number.isInteger(sourceType) && sourceType >= 0 && sourceType <= 12,
        'Invalid local item skill source',
    )
    const index = u64(stopping ? verify.related_index : verify.battle_index)
    ensure(index !== '0', 'Missing local item skill index')
    return passive ? `local-passive:${skillId}:${index}` : `local-item:${index}`
}
function limits(c, id) {
    const hero = [...c.state.player.heros_info.heros, ...(c.state.trialGroup?.heroes ?? [])].find((h) => h.guid === id)
    return hero ? heroBattleLimits(heroModules(c.tables, c.state, hero)) : null
}
function energyActors(c, battle) {
    const active = c.state.player.group_mgrs.find((manager) => manager.type === 1),
        formation = active?.groups.find((entry) => entry.id === active.cur_group),
        heroIds = new Set((formation?.heros ?? []).map((entry) => entry.hero_id).filter((id) => id && id !== '0')),
        activePets = [...c.state.pets, ...(c.state.trialGroup?.pets ?? [])].filter(
            (pet) => heroIds.has(pet.hero_id) && c.tables.find('template_value', pet.config_id),
        ),
        key = [...heroIds, ...activePets.map((pet) => pet.guid)].join(':')
    if (battle.energyActorKey === key && battle.energySpecs) return new Map(Object.entries(battle.energySpecs))
    const heroes = [...c.state.player.heros_info.heros, ...(c.state.trialGroup?.heroes ?? [])].filter((hero) =>
            heroIds.has(hero.guid),
        ),
        modules = heroes.map((hero) => heroModules(c.tables, c.state, hero)),
        specs = new Map()
    const add = (id, info, kind) => {
        const rate = info.modules
            .flatMap((module) => module.sub_modules)
            .flatMap((sub) => sub.attrs?.attrs ?? [])
            .filter((attr) => attr.attr_id === 110)
            .reduce((sum, attr) => sum + Number(attr.attr_val), 0)
        const maxSp = heroBattleLimits(info).sp
        if (Number.isFinite(rate) && rate >= 0 && maxSp > 0) specs.set(id, { kind, maxSp, rate: Math.min(20000, rate) })
    }
    for (const info of modules) add(info.hero_guid, info, 'hero')
    for (const pet of activePets) add(pet.guid, petModules(c.tables, c.state, pet, modules), 'pet')
    battle.petSp ??= {}
    battle.energyRemainders ??= {}
    battle.energyActorKey = key
    battle.energySpecs = Object.fromEntries(specs)
    return specs
}
function advanceEnergy(c, battle, changed) {
    const specs = energyActors(c, battle),
        previous = battle.energyUpdatedAt ?? c.now,
        seconds = Math.max(0, Math.min(30, c.now - previous))
    battle.energyUpdatedAt = c.now
    const set = (id, spec, milli) => {
        const hero = spec.kind === 'hero' && c.state.player.heros_info.battle_infos.find((info) => info.hero_id === id),
            before = hero ? hero.sp : (battle.petSp[id] ?? 0),
            bounded = Math.max(0, Math.min(spec.maxSp * 1000, Math.floor(milli))),
            after = Math.floor(bounded / 1000)
        battle.energyRemainders[id] = bounded % 1000
        if (hero) hero.sp = after
        else battle.petSp[id] = after
        if (after !== before)
            changed.set(
                id,
                hero
                    ? { uuid: id, hp: hero.hp, sp: after, alive_state: hero.alive_state, reason: 0 }
                    : { uuid: id, sp: after, reason: 0 },
            )
    }
    const current = (id, spec) =>
        (spec.kind === 'hero'
            ? (c.state.player.heros_info.battle_infos.find((info) => info.hero_id === id)?.sp ?? 0)
            : (battle.petSp[id] ?? 0)) *
            1000 +
        (battle.energyRemainders[id] ?? 0)
    if (seconds) for (const [id, spec] of specs) set(id, spec, current(id, spec) + spec.rate * seconds)
    const reported = (id, snapshot, delta = 0) => {
        const spec = specs.get(id)
        if (!spec) return
        const old = current(id, spec),
            absolute = Number.isInteger(snapshot) && snapshot >= 0 ? snapshot * 10 : null,
            change = Number.isInteger(delta) ? delta * 10 : 0
        // The client can report an older SP snapshot after the server tick.
        // Accept rising snapshots; a negative explicit delta can lower SP.
        const next = absolute === null ? old + change : Math.max(old, absolute) + Math.min(0, change)
        set(id, spec, next)
    }
    return reported
}
export function registerCombat(on) {
    on('SkillStart', (c, r) => {
        if (isRetiredTrialActor(c.state, r.unit_id)) return
        const id = skillActorKey(c, r, r.skill?.skill_id)
        if (c.state.petCaptureResults?.[id]) return
        ensure(r.skill?.skill_id > 0, 'Missing skill')
        const battle = combatState(c.state, c.now)
        boundedSet(
            battle.skills,
            id,
            { unit_id: u64(r.unit_id), skill: structuredClone(r.skill), op_time: u64(r.op_time), updated_at: c.now },
            256,
        )
        const hero = [...c.state.player.heros_info.heros, ...(c.state.trialGroup?.heroes ?? [])].find(
                (h) => h.guid === id,
            ),
            config = hero && (heroBattleConfig(c.tables, hero) || c.tables.find('hero', hero.conf_id))
        if (config && pairs(config.skillList).get(4) === r.skill.skill_id) {
            const value = c.state.player.heros_info.battle_infos.find((h) => h.hero_id === id)
            if (value) {
                value.sp = 0
                if (battle.energyRemainders) battle.energyRemainders[id] = 0
                c.push('CSProtoObjBattleInfoSync', {
                    infos: [{ uuid: id, hp: value.hp, sp: 0, alive_state: value.alive_state, reason: 0 }],
                })
            }
        }
        const p = [...c.state.pets, ...(c.state.trialGroup?.pets ?? [])].find((pet) => pet.guid === id)
        if (p) {
            const signature = String(c.tables.find('pet', p.config_id)?.signatureSkillList ?? '')
                .split('|')[0]
                ?.split('#')
                .map(Number)
            if (signature?.[1] === r.skill.skill_id) {
                battle.petSp ??= {}
                battle.petSp[id] = 0
                if (battle.energyRemainders) battle.energyRemainders[id] = 0
                c.push('CSProtoObjBattleInfoSync', { infos: [{ uuid: id, sp: 0, reason: 0 }] })
            }
        }
    })
    on('SkillStop', (c, r) => {
        if (isRetiredTrialActor(c.state, r.unit_id)) return
        const skillId = Number(u64(r.skill_id))
        if (
            u64(r.unit_id) === '0' &&
            isFormationPassive(c, skillId) &&
            r.verify_info &&
            u64(r.verify_info.battle_index) === '0' &&
            u64(r.verify_info.related_index) === '0'
        ) {
            const sourceType = r.verify_info.source_type ?? 0
            ensure(
                Number.isInteger(sourceType) && sourceType >= 0 && sourceType <= 12,
                'Invalid local passive skill source',
            )
            const battle = combatState(c.state, c.now)
            for (const [key, cast] of Object.entries(battle.skills))
                if (key.startsWith('local-passive:' + skillId + ':') && cast.unit_id === '0') delete battle.skills[key]
            return
        }
        const id = skillActorKey(c, r, Number(u64(r.skill_id)), true),
            battle = combatState(c.state, c.now),
            active = battle.skills[id]
        if (active && String(active.skill.skill_id) === u64(r.skill_id)) delete battle.skills[id]
    })
    on('CreateBullet', (c, r) => {
        const unit = actor(c, r.unit_id),
            items = r.bullet_info ?? []
        if (c.state.petCaptureResults?.[unit]) return
        ensure(items.length <= 256, 'Too many bullets')
        const battle = combatState(c.state, c.now)
        for (const bullet of items) {
            const id = u64(bullet.bullet_id)
            ensure(id !== '0' && bullet.config_id > 0, 'Invalid bullet')
            const previous = battle.bullets[id]
            ensure(!previous || previous.unit_id === unit, 'Bullet belongs to another actor')
            boundedSet(
                battle.bullets,
                id,
                { unit_id: unit, info: structuredClone(bullet), op_time: u64(r.op_time), updated_at: c.now },
                2048,
            )
        }
    })
    on('BulletActionChange', (c, r) => {
        const actions = r.action_info ?? []
        ensure(actions.length <= 256, 'Too many bullet actions')
        const battle = combatState(c.state, c.now)
        for (const action of actions) {
            const id = u64(action.bullet_id),
                unit = actor(c, action.unit_id),
                bullet = battle.bullets[id]
            if (!bullet) continue
            ensure(bullet.unit_id === unit, 'Bullet actor mismatch')
            bullet.action = structuredClone(action)
            bullet.updated_at = c.now
        }
    })
    on('ComboStart', (c) => {
        combatState(c.state, c.now).combo = { active: true, started_at: c.now }
    })
    on('ComboEnd', (c, r) => {
        const battle = combatState(c.state, c.now)
        battle.combo = {
            ...battle.combo,
            active: false,
            ended_at: c.now,
            count: r.combo_num ?? 0,
            reported_damage: u64(r.combo_damage),
        }
    })
    on('BattleInfoReduce', (c, r) => {
        const rows = expandBattleReport(r),
            battle = combatState(c.state, c.now),
            changed = new Map(),
            maximums = new Map(),
            enemyHurts = [],
            deadGroups = new Set()
        const entrustRun =
            c.state.entrust?.run?.map_id === c.state.world.map_id && c.state.entrust.run.status === 2
                ? c.state.entrust.run
                : null
        let entrustDamageChanged = false
        const reportSp = advanceEnergy(c, battle, changed)
        const update = (id, values, source) => {
            if (id === '0') return
            const saved = c.state.player.heros_info.battle_infos.find((h) => h.hero_id === id)
            if (saved) {
                const previousHp = saved.hp
                if (!maximums.has(id)) maximums.set(id, limits(c, id))
                const max = maximums.get(id)
                if (values.delta !== undefined) saved.hp = Math.max(0, Math.min(max.hp, saved.hp + values.delta))
                saved.alive_state = saved.hp > 0 ? 0 : 1
                if (entrustRun && entrustRun.hero_deaths !== undefined && previousHp > 0 && saved.hp === 0)
                    entrustRun.hero_deaths++
                changed.set(id, { uuid: id, hp: saved.hp, sp: saved.sp, alive_state: saved.alive_state, reason: 0 })
            } else {
                const previous = battle.entities[id] ?? { uuid: id },
                    definition = enemyDefinition(c.tables, c.state, id)
                if (definition && values.delta !== undefined) {
                    const hp =
                        previous.hp === 0
                            ? 0
                            : Math.max(
                                  0,
                                  Math.min(definition.max_hp, (previous.hp ?? definition.max_hp) + values.delta),
                              )
                    const value = {
                        ...previous,
                        ...definition,
                        ...values,
                        uuid: id,
                        hp,
                        sp: previous.sp ?? 0,
                        alive_state: hp > 0 ? 0 : 1,
                        updated_at: c.now,
                    }
                    const died = (previous.hp ?? definition.max_hp) > 0 && hp === 0
                    if (died) deadGroups.add(id)
                    if (died && source && source !== '0') value.final_blow_guid = source
                    const lost = Math.max(0, (previous.hp ?? definition.max_hp) - hp)
                    if (entrustRun && lost > 0 && isPlayerDamageSource(c.state, source)) {
                        entrustRun.damage_total = String(BigInt(entrustRun.damage_total ?? '0') + BigInt(lost))
                        entrustDamageChanged = true
                    }
                    boundedSet(battle.entities, id, value, 512)
                    if (died) recordGuidedKill(c.tables, c.state, value)
                    changed.set(id, {
                        uuid: id,
                        hp,
                        sp: value.sp,
                        alive_state: value.alive_state,
                        reason: 0,
                        ...(value.final_blow_guid ? { final_blow_guid: value.final_blow_guid } : {}),
                    })
                } else boundedSet(battle.entities, id, { ...previous, ...values, updated_at: c.now }, 512)
            }
        }
        for (const row of rows) {
            const actors = [
                row.hurt_info?.from_id,
                row.hurt_info?.tar_id,
                row.element_info?.tar_id,
                row.element_info?.buff?.creator_id,
                row.attr_change?.uuid,
            ]
            if (actors.some((id) => id && isRetiredTrialActor(c.state, id))) continue
            if (row.hurt_info) {
                const h = row.hurt_info
                if (c.state.petCaptureResults?.[h.from_id] || c.state.petCaptureResults?.[h.tar_id]) continue
                if (h.tar_id !== '0') actor(c, h.tar_id)
                if (h.from_id !== '0') actor(c, h.from_id)
                if (h.from_sp !== undefined || h.tar_sp !== undefined || h.delta_sp !== undefined) {
                    const trace = (battle.energyTrace ??= [])
                    trace.push({
                        time: c.now,
                        from: h.from_id,
                        target: h.tar_id,
                        from_sp: h.from_sp,
                        tar_sp: h.tar_sp,
                        delta_sp: h.delta_sp,
                    })
                    if (trace.length > 24) trace.shift()
                }
                const storyBattle =
                    c.state.world.map_id === 104 &&
                    [1n, 5n].includes(BigInt(h.tar_id) >> 56n) &&
                    c.state.tasks.some((t) => t.task_id === 106002 && t.nodes.some((n) => n.node_id === 59))
                const heroBefore = storyBattle
                        ? c.state.player.heros_info.battle_infos.find((x) => x.hero_id === h.tar_id)?.hp
                        : undefined,
                    boss = battle.entities[h.from_id],
                    prior = battle.entities[h.tar_id]?.hp
                update(
                    h.tar_id,
                    {
                        ...(h.hp_change !== undefined ? { delta: h.hp_change } : {}),
                        ...(h.cur_hp !== undefined ? { reported_hp: h.cur_hp } : {}),
                    },
                    h.from_id,
                )
                reportSp(h.from_id, h.from_sp)
                reportSp(h.tar_id, h.tar_sp, h.tar_sp === undefined ? h.delta_sp : 0)
                if (heroBefore !== undefined) {
                    const trace = (c.state.bossBattleTrace ??= [])
                    trace.push({
                        source: h.from_id,
                        source_config: boss?.config_id ?? null,
                        target: h.tar_id,
                        skill: h.skill_id ?? 0,
                        boss_hp: boss?.hp ?? null,
                        hero_before: heroBefore,
                        hp_change: h.hp_change ?? null,
                        client_hp: h.cur_hp ?? null,
                        server_hp:
                            c.state.player.heros_info.battle_infos.find((x) => x.hero_id === h.tar_id)?.hp ?? null,
                        hp_locked: !!h.hpLocked,
                        cur_phase: h.cur_phase ?? null,
                        time: c.now,
                    })
                    if (trace.length > 32) trace.splice(0, trace.length - 32)
                }
                const enemy = battle.entities[h.tar_id]
                if (enemy?.max_hp && enemy.hp <= Math.max(200, enemy.max_hp / 10)) {
                    const trace = (battle.nearDeathReports ??= [])
                    trace.push({
                        target: h.tar_id,
                        source: h.from_id,
                        skill: h.skill_id ?? 0,
                        prior_hp: prior ?? enemy.max_hp,
                        hp_change: h.hp_change ?? null,
                        client_hp: h.cur_hp ?? null,
                        server_hp: enemy.hp,
                        hp_locked: !!h.hpLocked,
                        shield_cur: (h.shield_cur ?? []).map((x) => ({ id: x.id, val: x.val })),
                        shield_chg: (h.shield_chg ?? []).map((x) => ({ id: x.id, val: x.val })),
                        time: c.now,
                    })
                    if (trace.length > 48) trace.splice(0, trace.length - 48)
                }
                if (enemy?.hp !== undefined) enemyHurts.push({ source: rows.indexOf(row), hp: enemy.hp })
            }
            if (row.attr_change) {
                const a = row.attr_change
                if (c.state.petCaptureResults?.[a.uuid]) continue
                actor(c, a.uuid)
                ensure((a.attrButeInfos ?? []).length <= 256, 'Too many attribute changes')
                boundedSet(
                    battle.entities,
                    a.uuid,
                    {
                        ...battle.entities[a.uuid],
                        uuid: a.uuid,
                        reported_attributes: a.attrButeInfos ?? [],
                        updated_at: c.now,
                    },
                    512,
                )
            }
            if (row.element_info) {
                const e = row.element_info
                if (c.state.petCaptureResults?.[e.tar_id] || c.state.petCaptureResults?.[e.buff?.creator_id]) continue
                if (e.tar_id !== '0') actor(c, e.tar_id)
                ensure(e.op >= 1 && e.op <= 10, 'Unknown element operation')
                const id = e.uniqueId
                if (e.op === 2) delete battle.elements[id]
                else if ([1, 7, 10].includes(e.op)) {
                    ensure(id !== '0' && e.buff, 'Missing element data')
                    boundedSet(battle.elements, id, { ...e, updated_at: c.now }, 2048)
                } else if (battle.elements[id]) {
                    const prev = battle.elements[id]
                    battle.elements[id] = { ...prev, ...e, buff: { ...prev.buff, ...e.buff }, updated_at: c.now }
                }
            }
        }
        battle.report_count++
        battle.last_base_time = u64(r.base_time)
        // HurtInfo updates HP only; publish alive state before its HP callback.
        if (changed.size) c.push('CSProtoObjBattleInfoSync', { infos: [...changed.values()] })
        if (enemyHurts.length)
            c.push('SCProtoBattleInfoReduceNtf', {
                uint64_dic: r.uint64_dic ?? [],
                base_time: r.base_time ?? '0',
                battle_info: enemyHurts.map(({ source, hp }) => ({
                    hurt_info: { ...r.battle_info[source].hurt_info, cur_hp: hp },
                })),
            })
        for (const id of deadGroups) finishEnemyGroupRelations(c, id)
        if (deadGroups.size) pruneInactiveCampaignRelations(c)
        advanceEntrustCombat(c)
        settleStoryCampaignScene(c)
        if (entrustDamageChanged && entrustRun.last_damage_sync_at !== c.now) {
            entrustRun.last_damage_sync_at = c.now
            c.push('SCProtoMultiCampaignPlayerDmgInfoSync', {
                info: [{ player_id: c.id, sum_dmg: entrustRun.damage_total }],
            })
        }
    })
    on('RequestHeroElement', (c, r) => {
        const ids = r.u64s ?? []
        ensure(ids.length <= 256, 'Too many element targets')
        const selected = new Set(ids.map((id) => actor(c, id))),
            battle = combatState(c.state, c.now)
        c.push('SCProtoElementInfoSync', {
            info: Object.values(battle.elements)
                .filter((e) => selected.has(e.tar_id))
                .map(({ updated_at, ...e }) => ({ ...e, op: 1 })),
            op_time: String(c.now * 1000),
        })
    })
    on('SkillEffectDone', (c, r) => {
        const id = actor(c, r.uuid)
        ensure(Number.isInteger(r.skill_id) && r.skill_id > 0, 'Invalid completed skill')
        const battle = combatState(c.state, c.now)
        battle.skillEffects ??= {}
        boundedSet(
            battle.skillEffects,
            id + ':' + r.skill_id,
            { uuid: id, skill_id: r.skill_id, updated_at: c.now },
            256,
        )
    })
    on('ShieldInfo', (c, r) => {
        const id = actor(c, r.uuid),
            shields = r.shield ?? []
        ensure(
            shields.length <= 32 &&
                shields.every((x) => Number.isInteger(x.id) && x.id > 0 && Number.isInteger(x.val) && x.val >= 0),
            'Invalid shield status',
        )
        const battle = combatState(c.state, c.now)
        battle.shields ??= {}
        boundedSet(
            battle.shields,
            id,
            shields.map((x) => ({ id: x.id, val: x.val })),
            512,
        )
    })
    on('ShieldInfoDel', (c, r) => {
        const id = actor(c, r.uuid),
            ids = r.shield_id ?? []
        ensure(ids.length <= 32 && ids.every((x) => Number.isInteger(x) && x > 0), 'Invalid shield removal')
        const battle = combatState(c.state, c.now)
        battle.shields ??= {}
        if (battle.shields[id]) {
            const removed = new Set(ids)
            battle.shields[id] = battle.shields[id].filter((x) => !removed.has(x.id))
            if (!battle.shields[id].length) delete battle.shields[id]
        }
    })
    on('PerfectDefense', (c, r) => {
        const defender = actor(c, r.uuid),
            target = actor(c, r.target_uuid),
            battle = combatState(c.state, c.now)
        ensure(enemyDefinition(c.tables, c.state, target) || battle.entities[target], 'Unknown defense target')
        battle.perfectDefenses ??= {}
        boundedSet(battle.perfectDefenses, defender + ':' + target, { defender, target, time: c.now }, 128)
    })
    for (const [name, phase, notification] of [
        ['CombineAttackBegin', 'begin', 'SCProtoCombineAttackBeginNtf'],
        ['CombineAttackEnd', 'end', 'SCProtoCombineAttackEndNtf'],
    ])
        on(name, (c, r) => {
            const attackId = actor(c, r.attack_id),
                targetId = actor(c, r.target_id),
                battle = combatState(c.state, c.now)
            ensure(
                enemyDefinition(c.tables, c.state, targetId) || battle.entities[targetId],
                'Unknown combine-attack target',
            )
            battle.combineAttacks ??= {}
            const key = attackId + ':' + targetId,
                previous = battle.combineAttacks[key] ?? { attack_id: attackId, target_id: targetId }
            boundedSet(battle.combineAttacks, key, { ...previous, [phase + '_at']: c.now }, 128)
            c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, notification, {
                attack_id: attackId,
                target_id: targetId,
            })
        })
}
