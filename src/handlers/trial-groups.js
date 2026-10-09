import { trialSoulEssence } from '../trial-equipment.js'
import { TaskGraphs, asList, nodeConditions } from '../tasks.js'
import { ensure, manager, group } from './common.js'
import { syncBattle, pairs } from '../battle.js'
import { petData } from '../pets.js'
import { retireTrialActors } from '../trial-actors.js'
import { mainHeroConfigId } from '../main-hero.js'
export function trialPayload(state) {
    return { trial_heros: state.trialGroup?.heroes ?? [], trial_pets: state.trialGroup?.pets ?? [] }
}
export function refreshTrialPetBindings(state) {
    const heroes = [...state.player.heros_info.heros, ...(state.trialGroup?.heroes ?? [])],
        expected = new Map(),
        pets = new Map((state.trialGroup?.pets ?? []).map((p) => [p.guid, p]))
    const active = state.trialGroup && manager(state).groups.find((g) => g.id === 0)
    for (const slot of active?.heros ?? []) {
        const pet = pets.get(slot.pet_id)
        if (pet && slot.hero_id && slot.hero_id !== '0') {
            expected.set(slot.hero_id, pet.guid)
            pet.hero_id = slot.hero_id
        }
    }
    let changed = false
    for (const hero of heroes) {
        const id = expected.get(hero.guid) ?? '0'
        if (hero.trial_pet !== id) {
            hero.trial_pet = id
            changed = true
        }
    }
    return changed
}
// The middle 24 bits are the pet_interim row ID. Client GetUuid2ConfigId
// looks that ID up directly; adding 0x800000 made row 102 appear as 8388710.
const trialPetGuid = (account, id) => ((9n << 56n) | (BigInt(id) << 32n) | BigInt(account)).toString()
const trialHeroGuid = (account, id) => ((5n << 56n) | (BigInt(id) << 32n) | BigInt(account)).toString()
function trialHeroConfigId(tables, config, state) {
    // Main-avatar interim rows use a male prototype. FormationUtil retains the
    // player's real avatar, so the hero ID must match its sex or clothingAstF/M
    // has no animation mapping (199002 + female clothes10001 was empty).
    if (config.heroType === 1 && [mainHeroConfigId(tables, 1), mainHeroConfigId(tables, 2)].includes(config.heroId))
        return mainHeroConfigId(tables, state.player.basic_info.wardrobe?.sex ?? state.player.basic_info.sex)
    return config.heroId
}

function applyTrialPetComprehension(pet, cfg) {
    // rsp_syncTrialPetItem replaces aptitude with pet_interim.param in the client.
    // The battle attribute packet must use those same values, not an owned-pet roll.
    const values = pairs(cfg.param)
    if (!values.size) return false
    const comprehension = [...values].map(([attr_id, value]) => ({
        attr_id,
        value,
        level: 1,
        init_level: 1,
        cur_exp: 0,
    }))
    if (JSON.stringify(pet.comprehension) === JSON.stringify(comprehension)) return false
    pet.comprehension = comprehension
    return true
}
export function repairTrialActorGuids(tables, state) {
    const trial = state.trialGroup
    if (!trial) return false
    const account = state.player.basic_info.id,
        m = manager(state)
    let changed = false
    for (let index = 0; index < (trial.heroes ?? []).length; index++) {
        const hero = trial.heroes[index],
            interimId = trial.ids[index]
        const config = tables.find('hero_interim', interimId)
        if (!config) continue
        const configId = trialHeroConfigId(tables, config, state)
        if (![config.heroId, configId].includes(hero.conf_id)) continue
        if (hero.conf_id !== configId) {
            hero.conf_id = configId
            changed = true
        }
        const old = hero.guid,
            correct = trialHeroGuid(account, interimId)
        if (old === correct) continue
        hero.guid = correct
        for (const g of m.groups) {
            if (g.control === old) g.control = correct
            for (const slot of g.heros) if (slot.hero_id === old) slot.hero_id = correct
        }
        for (const pet of trial.pets ?? []) if (pet.hero_id === old) pet.hero_id = correct
        if (state.world.control_ready === old) state.world.control_ready = correct
        const combat = state.combat
        if (combat) {
            for (const field of ['entities', 'skills', 'breakValues', 'shields'])
                if (combat[field]) delete combat[field][old]
            for (const [key, bullet] of Object.entries(combat.bullets ?? {}))
                if (bullet.unit_id === old) delete combat.bullets[key]
        }
        changed = true
    }
    for (const pet of trial.pets ?? []) {
        const old = pet.guid,
            encoded = Number((BigInt(old) >> 32n) & 0xffffffn),
            interimId = encoded >= 0x800000 ? encoded - 0x800000 : encoded
        const cfg = tables.find('pet_interim', interimId)
        if (cfg?.petId !== pet.config_id) continue
        if (applyTrialPetComprehension(pet, cfg)) changed = true
        const correct = trialPetGuid(account, interimId)
        if (old === correct) continue
        pet.guid = correct
        for (const g of m.groups) for (const slot of g.heros) if (slot.pet_id === old) slot.pet_id = correct
        for (const hero of trial.heroes ?? []) if (hero.pet_id === old) hero.pet_id = correct
        const combat = state.combat
        if (combat) {
            for (const field of ['entities', 'skills', 'breakValues', 'shields', 'petPresentation'])
                if (combat[field]) {
                    delete combat[field][old]
                }
            for (const [key, bullet] of Object.entries(combat.bullets ?? {}))
                if (bullet.unit_id === old) delete combat.bullets[key]
            for (const [key, element] of Object.entries(combat.elements ?? {}))
                if (element.tar_id === old || element.buff?.creator_id === old) delete combat.elements[key]
        }
        changed = true
    }
    return changed
}
export function isPreviousTrialActor(state, id) {
    const trial = state.trialGroup
    if (!trial) return false
    return (
        manager(state)
            .groups.find((g) => g.id === trial.previous_group)
            ?.heros.some((h) => h.hero_id === id) ?? false
    )
}
const emptySlot = () => ({ hero_id: '0', pet_id: '0' })
const graphCaches = new WeakMap()
export function restoreMixedTrialGroup(tables, state) {
    const trial = state.trialGroup
    if (!trial) return false
    const repaired = repairTrialActorGuids(tables, state)
    const m = manager(state),
        active = m.groups.find((g) => g.id === 0),
        original = m.groups.find((g) => g.id === trial.previous_group)
    if (!active || !original) return refreshTrialPetBindings(state) || repaired
    let forced = trial.force
    if (forced === undefined) {
        let graphs = graphCaches.get(tables)
        if (!graphs) {
            graphs = new TaskGraphs(tables)
            graphCaches.set(tables, graphs)
        }
        const task = state.tasks.find((t) => t.task_id === trial.task_id),
            controller =
                task &&
                graphs
                    .get(task.task_id)
                    .controllers.find(
                        (row) =>
                            row.__type_TaskTeamController &&
                            task.nodes.some((n) => asList(row.field_530003).includes(n.node_id)),
                    )
        forced = !!controller?.__type_TaskTeamController?.isForceChange
    }
    if (forced) return refreshTrialPetBindings(state) || repaired
    const maxSlots = trial.story_campaign ? 4 : 3
    const positions = structuredClone(original.heros),
        used = new Set()
    for (let index = 0; index < (trial.heroes ?? []).length; index++) {
        const hero = trial.heroes[index],
            requested = trial.heroSlots?.[trial.ids[index]] ?? -1
        let pos =
            requested >= 0
                ? requested
                : positions.findIndex((slot, i) => !used.has(i) && (!slot.hero_id || slot.hero_id === '0'))
        if (pos < 0 && positions.length < maxSlots) pos = positions.length
        if (pos < 0)
            for (let i = positions.length - 1; i >= 0; i--)
                if (!used.has(i) && positions[i].hero_id !== original.control) {
                    pos = i
                    break
                }
        if (pos < 0)
            for (let i = positions.length - 1; i >= 0; i--)
                if (!used.has(i)) {
                    pos = i
                    break
                }
        ensure(pos >= 0 && pos < maxSlots && !used.has(pos), 'Trial formation has no free slot')
        while (positions.length <= pos) positions.push(emptySlot())
        positions[pos] = { ...positions[pos], hero_id: hero.guid }
        used.add(pos)
    }
    const pets = new Set((trial.pets ?? []).map((p) => p.guid))
    for (let index = 0; index < active.heros.length && index < maxSlots; index++) {
        const petId = active.heros[index].pet_id
        if (!pets.has(petId)) continue
        while (positions.length <= index) positions.push(emptySlot())
        positions[index].pet_id = petId
        const pet = trial.pets.find((p) => p.guid === petId)
        pet.hero_id = positions[index].hero_id
    }
    const control = positions.some((h) => h.hero_id === active.control)
        ? active.control
        : (trial.heroes?.[0]?.guid ?? '0')
    const changed =
        JSON.stringify(active.heros) !== JSON.stringify(positions) || active.control !== control || m.cur_group !== 0
    if (changed) {
        active.heros = positions
        active.control = control
        m.cur_group = 0
        m.src = 0
    }
    return refreshTrialPetBindings(state) || changed || repaired
}
export function expireTaskTrialGroup(tables, state) {
    const trial = state.trialGroup
    if (!trial) return false
    let graphs = graphCaches.get(tables)
    if (!graphs) {
        graphs = new TaskGraphs(tables)
        graphCaches.set(tables, graphs)
    }
    const task = state.tasks.find((t) => t.task_id === trial.task_id)
    const storyTrial =
        trial.story_campaign &&
        state.storyCampaign?.map_id === state.world.map_id &&
        task?.nodes.some((node) =>
            nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some(
                (condition) =>
                    condition.__type_TaskConditionBaseData?.__type_TaskCondDungeonData?.dungeonId ===
                    state.storyCampaign.dungeon_id,
            ),
        ) &&
        trial.ids.every((id) =>
            String(
                tables.find('dungeon_scene', state.world.map_id)?.[trial.scene_trial_field ?? 'extraTrialGroup'] ?? '',
            )
                .split('|')
                .some((entry) => Number(entry.split('#')[0]) === id),
        )
    const valid =
        storyTrial ||
        (task &&
            graphs.get(task.task_id).controllers.some((controller) => {
                const d = controller.__type_TaskTeamController
                return (
                    d &&
                    asList(d.stateScene).includes(state.world.map_id) &&
                    task.nodes.some((n) => asList(controller.field_530003).includes(n.node_id)) &&
                    trial.ids.every((id) => asList(d.teamMemberList).some((m) => m.memberId === id))
                )
            }))
    if (valid) {
        manager(state).src = 0
        return false
    }
    const m = manager(state)
    retireTrialActors(state, [...(trial.heroes ?? []), ...(trial.pets ?? [])])
    m.groups = m.groups.filter((g) => g.id !== 0)
    m.cur_group = trial.previous_group
    m.src = 0
    delete state.trialGroup
    refreshTrialPetBindings(state)
    return true
}
function attachTrialPets(c, tables, trial, positions, requested) {
    const unique = new Map()
    for (const item of requested) {
        ensure(
            Number.isInteger(item.pos) && item.pos >= 0 && item.pos < 3 && Number.isInteger(item.id) && item.id > 0,
            'Invalid trial pet slot',
        )
        ensure(!unique.has(item.id) || unique.get(item.id) === item.pos, 'Conflicting trial pet positions')
        unique.set(item.id, item.pos)
    }
    ensure(unique.size <= 3, 'Too many trial pets')
    const pets = [...(trial.pets ?? [])],
        petIds = [...(trial.petIds ?? [])]
    for (const [id, pos] of unique) {
        while (positions.length <= pos) positions.push(emptySlot())
        const cfg = tables.find('pet_interim', id)
        ensure(
            cfg && tables.find('pet', cfg.petId) && tables.find('template_value', cfg.petId),
            'Unknown trial pet',
            1007,
        )
        const guid = trialPetGuid(c.id, cfg.id)
        let pet = pets.find((p) => p.guid === guid)
        if (!pet) {
            pet = petData(tables, cfg.petId, guid, 0)
            pet.type = 2
            pet.lv = cfg.petLevel
            pet.feature = cfg.feature || 1
            const skills = new Map(pet.inherent_skills.map((skill) => [skill.skill_slot, skill]))
            if (cfg.signatureSkillList)
                skills.set(206, { skill_slot: 206, skill_id: cfg.signatureSkillList, skill_lv: 1, type: 0 })
            String(cfg.skillList || '')
                .split('|')
                .filter(Boolean)
                .forEach((skill, index) =>
                    skills.set(index + 1, { skill_slot: index + 1, skill_id: Number(skill), skill_lv: 1, type: 0 }),
                )
            pet.inherent_skills = [...skills.values()]
            pets.push(pet)
        }
        applyTrialPetComprehension(pet, cfg)
        pet.hero_id = positions[pos].hero_id || '0'
        if (!petIds.includes(cfg.id)) petIds.push(cfg.id)
        positions[pos].pet_id = guid
    }
    trial.pets = pets
    trial.petIds = petIds
}
export function registerTrialGroups(on, tables) {
    // Task ChangeTrialFormation needs ACK first to arm its event listeners.
    // Dungeon TrialFormationSPC instead treats ACK as loading complete; its
    // new actors and active group must be installed before that callback runs.
    // Attribute/skill caches precede TrialDatas because it can recreate entities.
    const publish = (c, sceneTrial = c.state.trialGroup?.story_campaign) => {
        const output = sceneTrial ? { ...c, push: c.pushBefore } : c
        refreshTrialPetBindings(c.state)
        syncBattle(output)
        output.push('CSProtoTrialDatas', trialPayload(c.state))
        output.push('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
        output.push('CSProtoSyncPlayerData', { group_mgrs: c.state.player.group_mgrs })
    }
    const graphs = new TaskGraphs(tables),
        rows = tables.get('hero_interim'),
        configs = new Map(rows.map((r) => [r.id, r]))
    on('TrialGroupChange', (c, r) => {
        const m = manager(c.state),
            existing = c.state.trialGroup
        if (existing) restoreMixedTrialGroup(tables, c.state)
        if (!r.open) {
            if (!existing) return {}
            const removePets = [...new Set((r.trial_pets ?? []).map((x) => x.id))]
            if (removePets.length && !(r.trial_heros ?? []).length && !r.force) {
                ensure(
                    removePets.every((id) => (existing.petIds ?? []).includes(id)),
                    'Unknown trial removal',
                )
                const removed = new Set(removePets.map((id) => trialPetGuid(c.id, id)))
                retireTrialActors(
                    c.state,
                    (existing.pets ?? []).filter((p) => removed.has(p.guid)),
                )
                existing.pets = (existing.pets ?? []).filter((p) => !removed.has(p.guid))
                existing.petIds = (existing.petIds ?? []).filter((id) => !removePets.includes(id))
                const active = m.groups.find((g) => g.id === 0),
                    original = m.groups.find((g) => g.id === existing.previous_group)
                if (active)
                    active.heros.forEach((slot, index) => {
                        if (removed.has(slot.pet_id)) slot.pet_id = original?.heros[index]?.pet_id ?? '0'
                    })
                publish(c)
                return {}
            }
            ensure(
                r.force ||
                    ((r.trial_heros ?? []).length > 0 &&
                        existing.ids.every((id) => r.trial_heros.some((x) => x.id === id))),
                'Unknown trial removal',
            )
            retireTrialActors(c.state, [...(existing.heroes ?? []), ...(existing.pets ?? [])])
            m.groups = m.groups.filter((g) => g.id !== 0)
            m.cur_group = existing.previous_group
            m.src = 0
            delete c.state.trialGroup
            publish(c, existing.story_campaign)
            return {}
        }
        const requested = r.trial_heros ?? [],
            // The client includes id=0 as an empty pet slot in chapter 6200.
            requestedPets = (r.trial_pets ?? []).filter((item) => item.id > 0)
        if (!requested.length && requestedPets.length) {
            ensure(
                existing &&
                    requestedPets.length <= 6 &&
                    existing.task_id === c.state.tasks.find((t) => t.task_id === existing.task_id)?.task_id,
                'Trial pet requires an active trial task',
            )
            const active = m.groups.find((g) => g.id === 0)
            ensure(active, 'Temporary trial group unavailable')
            const positions = structuredClone(active.heros)
            attachTrialPets(c, tables, existing, positions, requestedPets)
            active.heros = positions
            publish(c)
            return {}
        }
        ensure(
            requested.length > 0 && requested.length <= 3 && requestedPets.length <= 6,
            'Unsupported trial formation shape',
        )
        const storyTask =
            c.state.storyCampaign?.map_id === c.state.world.map_id &&
            c.state.tasks.find((task) =>
                task.nodes.some((node) =>
                    nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some(
                        (condition) =>
                            condition.__type_TaskConditionBaseData?.__type_TaskCondDungeonData?.dungeonId ===
                            c.state.storyCampaign.dungeon_id,
                    ),
                ),
            )
        const story = !!storyTask
        const sceneTrialField = r.force ? 'trailGroup' : 'extraTrialGroup'
        const maxSlots = story && !r.force ? 4 : 3
        ensure(
            new Set(requested.map((x) => x.id)).size === requested.length &&
                requested.every((x) => Number.isInteger(x.pos) && x.pos >= -1 && x.pos < maxSlots),
            'Invalid trial slots',
        )
        const candidates = []
        for (const task of c.state.tasks) {
            const graph = graphs.get(task.task_id)
            for (const controller of graph.controllers) {
                const data = controller.__type_TaskTeamController
                if (
                    !data ||
                    !asList(data.stateScene).includes(c.state.world.map_id) ||
                    !task.nodes.some((n) => asList(controller.field_530003).includes(n.node_id))
                )
                    continue
                const members = asList(data.teamMemberList)
                if (requested.every((r) => members.some((v) => v.memberId === r.id)))
                    candidates.push({ task, data, members })
            }
        }
        if (story) {
            const task = storyTask
            const scene = tables.find('dungeon_scene', c.state.world.map_id)
            const members = String(scene?.[sceneTrialField] ?? '')
                .split('|')
                .map((entry) => ({ memberId: Number(entry.split('#')[0]) }))
                .filter((entry) => entry.memberId > 0)
            if (requested.every((entry) => members.some((member) => member.memberId === entry.id)))
                candidates.push({ task, data: { isForceChange: r.force ? 1 : 0 }, members })
        }
        ensure(candidates.length === 1, 'Trial formation does not match active task')
        const active = candidates[0]
        ensure(!!r.force === !!active.data.isForceChange, 'Trial replacement mode mismatch')
        const heroes = requested.map((item) => {
            const cfg = configs.get(item.id)
            ensure(cfg && tables.find('hero', cfg.heroId), 'Unknown trial hero', 1007)
            ensure(
                !cfg.accessorySet && !cfg.talentrune,
                'Trial accessory or talent configuration not implemented',
                1007,
            )
            trialSoulEssence(tables, cfg)
            const guid = trialHeroGuid(c.id, cfg.id)
            return {
                guid,
                conf_id: trialHeroConfigId(tables, cfg, c.state),
                hero_lv: cfg.level,
                hero_exp: 0,
                hero_rank: cfg.rank,
                hero_star: cfg.starLevel,
                hero_grade: cfg.gradeLevel,
                system_skill_levels: String(cfg.skilllevel).split('|').map(Number),
                trail: true,
                type: cfg.heroType,
                wguid: 0,
                pet_id: '0',
                favorability_lv: 1,
            }
        })
        const original = existing ? m.groups.find((g) => g.id === existing.previous_group) : group(c.state)
        ensure(original, 'Original formation unavailable')
        ensure(!existing || existing.task_id === active.task.task_id, 'Trial task changed')
        const positions = existing
            ? structuredClone(m.groups.find((g) => g.id === 0)?.heros ?? [])
            : r.force
              ? []
              : structuredClone(original.heros)
        const occupied = new Set()
        requested.forEach((item, index) => {
            let resolved = item.pos
            if (resolved < 0) {
                resolved = positions.findIndex((x, i) => !occupied.has(i) && x.hero_id === heroes[index].guid)
                if (resolved < 0)
                    resolved = positions.findIndex((x, i) => !occupied.has(i) && (!x.hero_id || x.hero_id === '0'))
                if (resolved < 0 && positions.length < maxSlots) resolved = positions.length
                if (resolved < 0)
                    for (let i = positions.length - 1; i >= 0; i--)
                        if (!occupied.has(i) && positions[i].hero_id !== original.control) {
                            resolved = i
                            break
                        }
                if (resolved < 0)
                    for (let i = positions.length - 1; i >= 0; i--)
                        if (!occupied.has(i)) {
                            resolved = i
                            break
                        }
            }
            ensure(resolved >= 0 && resolved < maxSlots && !occupied.has(resolved), 'Trial formation has no free slot')
            while (positions.length <= resolved) positions.push(emptySlot())
            positions[resolved] = { ...positions[resolved], hero_id: heroes[index].guid }
            occupied.add(resolved)
        })
        const previousControl = existing ? m.groups.find((g) => g.id === 0)?.control : null
        let control = positions.some((h) => h.hero_id === previousControl) ? previousControl : heroes[0].guid
        if (r.trial_control?.id) {
            const idx = requested.findIndex((x) => x.id === r.trial_control.id)
            ensure(idx >= 0, 'Trial control not in formation')
            control = heroes[idx].guid
        }
        c.state.trialGroup = {
            previous_group: existing?.previous_group ?? m.cur_group,
            task_id: active.task.task_id,
            ids: requested.map((x) => x.id),
            heroes,
            pets: existing?.pets ?? [],
            petIds: existing?.petIds ?? [],
            force: !!r.force,
            story_campaign: story,
            scene_trial_field: story ? sceneTrialField : undefined,
            heroSlots: Object.fromEntries(requested.map((item) => [item.id, item.pos])),
        }
        if (requestedPets.length) attachTrialPets(c, tables, c.state.trialGroup, positions, requestedPets)
        m.groups = m.groups.filter((g) => g.id !== 0)
        m.groups.push({ id: 0, heros: positions, control })
        if (!existing) m.last_group = m.cur_group
        m.cur_group = 0
        m.src = 0
        publish(c)
        return {}
    })
}
