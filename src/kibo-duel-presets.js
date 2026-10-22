import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { u64 } from './combat-state.js'
import { duelProgressSnapshot } from './kibo-duel-progress.js'

export const KIBO_LOCKED_SLOT = 98
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
function constant(tables, title) {
    const row = tables.get('game').find((row) => row.title === title),
        value = Number(row?.value)
    ensure(Number.isSafeInteger(value) && value > 0, 'Kibo formation constant missing: ' + title, ErrorCode.GameConfig)
    return value
}
export function duelPresetSnapshotGroups(tables, state) {
    const count = constant(tables, 'KIBO_DUEL_FORMATION_NUM_LIMIT'),
        size = constant(tables, 'KIBO_DUEL_FORMATION_MAX_NUM')
    const groups = Object.values(state.kiboDuelGroups ?? {})
    for (let slot = 1; slot <= count; slot++)
        if (!groups.some((group) => group.slot === slot))
            groups.push({
                slot,
                hero: '0',
                hero_skills: [],
                duel_id: 0,
                index: 0,
                pet_guids: Array.from({ length: size }, () => ({ id: '0', guid: '0', is_trial: false })),
            })
    return groups
}
function pets(tables, state, entries, duel, slot) {
    const size = constant(tables, 'KIBO_DUEL_FORMATION_MAX_NUM')
    ensure(
        Array.isArray(entries) && entries.length <= size,
        'Too many duel pet slots',
        ErrorCode.KiboDuelGroupPetExceedMaxNum,
    )
    const sameId = Number(tables.get('game').find((row) => row.title === 'KIBO_DUEL_SAME_ID_PET_ALLOW')?.value)
    ensure(sameId === 0 || sameId === 1, 'Invalid duel same-species rule', ErrorCode.GameConfig)
    const seen = new Set(),
        configs = new Set(),
        allowedTrials = new Set(ids(duel?.kiboList))
    const result = entries.map((entry) => {
        const id = u64(entry.id),
            guid = u64(entry.guid)
        if (id === '0' && guid === '0') return { id: '0', guid: '0', is_trial: false }
        let owned, configId, identity, canonical
        if (entry.is_trial) {
            ensure(duel, 'Trial pets require their configured duel', ErrorCode.InvalidArgument)
            ensure(duel.levelType !== 0, 'This duel only permits owned pets', ErrorCode.LKiboDuelOnlyPlayerPet)
            ensure(
                slot === KIBO_LOCKED_SLOT,
                'Trial pets require their prepared duel formation',
                ErrorCode.InvalidArgument,
            )
            const trialId = Number(id),
                trial = tables.find('trial_pet', trialId)
            ensure(
                Number.isSafeInteger(trialId) && trialId > 0 && trial && allowedTrials.has(trialId),
                'Trial pet is not configured for this duel',
                ErrorCode.TrialPetNotExist,
            )
            const actor = ((9n << 56n) | (BigInt(trialId) << 32n) | BigInt(state.player.basic_info.id)).toString()
            ensure(guid === '0' || guid === actor, 'Trial pet actor identity mismatch', ErrorCode.InvalidArgument)
            configId = trial.trialPet
            identity = 'trial:' + trialId
            canonical = { id: String(trialId), guid: actor, is_trial: true }
        } else {
            ensure(!duel || duel.levelType !== 2, 'This duel only permits trial pets', ErrorCode.LKiboDuelOnlyTrialPet)
            const selected = guid !== '0' ? guid : id
            owned = state.pets.find((pet) => String(pet.guid) === selected)
            ensure(owned && !owned.trial && !owned.trail, 'Duel pet instance is not owned', ErrorCode.PetNotExist)
            // Managed TrialPet.id is int32 while .guid retains uint64; its
            // sender writes id as uint32. Never find an instance by a truncated ID.
            ensure(
                id === '0' || id === selected || (guid !== '0' && BigInt(id) === (BigInt(selected) & 0xffffffffn)),
                'Duel pet identities disagree',
                ErrorCode.InvalidArgument,
            )
            configId = owned.config_id
            identity = 'owned:' + selected
            canonical = { id: selected, guid: selected, is_trial: false }
        }
        ensure(tables.find('pet', configId), 'Duel pet configuration missing', ErrorCode.PetConfNotExist)
        ensure(!seen.has(identity), 'A pet instance appears twice', ErrorCode.KiboDuelGroupSamePet)
        seen.add(identity)
        ensure(
            sameId === 1 || !configs.has(configId),
            'Duplicate pet species are disabled',
            ErrorCode.KiboDuelGroupSamePetId,
        )
        configs.add(configId)
        return canonical
    })
    while (result.length < size) result.push({ id: '0', guid: '0', is_trial: false })
    return result
}
function skills(tables, state, raw, duel) {
    const max = constant(tables, 'KIBO_DUEL_FORMATION_CHAR_SKILL_NUM')
    ensure(Array.isArray(raw) && raw.length <= max, 'Too many trainer skills', ErrorCode.KiboDuelAllSkillExceedMaxNum)
    if (duel)
        ensure(
            Number.isInteger(duel.skillNumber) && raw.length <= duel.skillNumber,
            'Too many active skills for this duel',
            ErrorCode.KiboDuelSkillExceedMaxNum,
        )
    const rows = tables.get('kibo_duel_skill'),
        unlocked = new Set(duelProgressSnapshot(tables, state).unlock_skills),
        pool = duel ? new Set(ids(duel.skillList)) : new Set(rows.map((row) => row.skillId))
    const seen = new Set(),
        slots = new Set()
    return raw
        .map((entry) => {
            const config = rows.find((row) => row.skillId === entry.skill_id)
            ensure(
                config && pool.has(entry.skill_id) && (config.defaultSkill === 1 || unlocked.has(entry.skill_id)),
                'Trainer skill is outside the available duel pool',
                ErrorCode.KiboDuelSkillNotExist,
            )
            ensure(!seen.has(entry.skill_id), 'Duplicate trainer skill', ErrorCode.KiboDuelSameHeroSkill)
            seen.add(entry.skill_id)
            ensure(
                entry.skill_lv === 1 &&
                    entry.type === 1 &&
                    Number.isInteger(entry.skill_slot) &&
                    entry.skill_slot >= 701 &&
                    entry.skill_slot < 701 + max &&
                    !slots.has(entry.skill_slot),
                'Invalid trainer skill layout',
                ErrorCode.InvalidArgument,
            )
            slots.add(entry.skill_slot)
            return { skill_id: entry.skill_id, skill_lv: 1, skill_slot: entry.skill_slot, type: 1 }
        })
        .sort((a, b) => a.skill_slot - b.skill_slot)
}
export function editDuelPreset(c, r, publish) {
    const max = constant(c.tables, 'KIBO_DUEL_FORMATION_NUM_LIMIT'),
        slot = r.slot
    ensure(Number.isInteger(slot) && slot > 0, 'Invalid duel preset slot', ErrorCode.InvalidArgument)
    ensure(
        slot <= max || slot === KIBO_LOCKED_SLOT,
        'Duel preset slot exceeds configured limit',
        ErrorCode.KiboDuelGroupExceedMaxNum,
    )
    const duelId = r.duel_id ?? 0,
        duel = duelId ? c.tables.find('kibo_duel', duelId) : null
    ensure(!duelId || duel, 'Unknown duel configuration', ErrorCode.KiboDuelConfNotExist)
    ensure(!duel || [0, 1, 2].includes(duel.levelType), 'Invalid duel pet policy', ErrorCode.GameConfig)
    const existing = c.state.kiboDuelGroups?.[slot],
        index = r.index ?? 0
    if (slot === KIBO_LOCKED_SLOT)
        ensure(
            existing && duel && existing.duel_id === duel.id,
            'Locked duel formation is not prepared',
            ErrorCode.KiboDuelCurGroupNotSet,
        )
    ensure(
        index === (slot === KIBO_LOCKED_SLOT ? existing.index : 0),
        'Cannot change locked duel slots',
        ErrorCode.InvalidArgument,
    )
    const pet_guids = pets(c.tables, c.state, r.pet_guids ?? [], duel, slot),
        hero = u64(r.hero)
    const trialHero = slot === KIBO_LOCKED_SLOT && duel.trialRole && hero === String(existing.hero)
    ensure(
        hero === '0' || trialHero || c.state.player.heros_info.heros.some((h) => h.guid === hero && !h.trail),
        'Duel trainer is not owned',
        ErrorCode.HeroNotExist,
    )
    if (slot === KIBO_LOCKED_SLOT) {
        ensure(
            Number.isInteger(existing.index) && existing.index >= 0 && existing.index <= pet_guids.length,
            'Invalid locked duel prefix',
            ErrorCode.GameConfig,
        )
        for (let i = 0; i < existing.index; i++)
            ensure(
                pet_guids[i].id === String(existing.pet_guids[i]?.id ?? '0') &&
                    pet_guids[i].is_trial === !!existing.pet_guids[i]?.is_trial,
                'Cannot change a fixed duel pet slot',
                ErrorCode.InvalidArgument,
            )
        if (duel.trialRole)
            ensure(
                hero === String(existing.hero),
                'Cannot replace the configured trial trainer',
                ErrorCode.InvalidArgument,
            )
    }
    const hero_skills = skills(c.tables, c.state, r.hero_skills ?? [], duel)
    ;(c.state.kiboDuelGroups ??= {})[slot] = { slot, pet_guids, hero, hero_skills, duel_id: duelId, index }
    publish(c)
    return {}
}
export function registerDuelPresetEditing(on, tables, snapshot) {
    const publish = (c) => c.pushBefore('CSProtoKiboDuelGroupInfoSync', snapshot(c.state, tables))
    on('KiboDuelGroupInfoChange', (c, r) => editDuelPreset(c, r, publish))
}
