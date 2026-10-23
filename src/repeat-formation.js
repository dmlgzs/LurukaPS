import configured from '../configs/repeat-favor-roster-heroes.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure, GameError } from './handlers/common.js'
import { repeatDungeon } from './repeat-event.js'

const eligibility = new Map(configured.heroes.map((row) => [row.id, row.favor]))
function roster(state) {
    const manager = state.player.group_mgrs.find((row) => row.type === 1)
    const group = manager?.groups.find((row) => row.id === manager.cur_group)
    ensure(
        group && Array.isArray(group.heros) && group.heros.length > 0 && group.heros.length <= 3,
        'Invalid active repeat formation',
        ErrorCode.GameConfig,
    )
    const seen = new Set(),
        seenPets = new Set(),
        slots = []
    for (let i = 0; i < 3; i++) {
        const slot = group.heros[i],
            heroId = String(slot?.hero_id ?? '0'),
            petId = String(slot?.pet_id ?? '0')
        if (heroId === '0') {
            ensure(petId === '0', 'Pet is assigned to an empty repeat slot', ErrorCode.GameConfig)
            slots.push({ hero_id: '0', pet_id: '0' })
            continue
        }
        const hero = state.player.heros_info.heros.find((hero) => hero.guid === heroId)
        ensure(
            hero && !hero.trail && !seen.has(heroId),
            'Repeat member is not a unique owned hero',
            ErrorCode.HeroNotExist,
        )
        ensure(
            eligibility.has(hero.conf_id),
            'Repeat hero favor eligibility configuration unavailable',
            ErrorCode.GameConfig,
        )
        ensure(
            String(hero.pet_id ?? '0') === petId,
            'Repeat pet slot does not match owned binding',
            ErrorCode.GameConfig,
        )
        if (petId !== '0') {
            const pet = state.pets.find((pet) => pet.guid === petId)
            ensure(
                pet && !pet.trail && !seenPets.has(petId) && String(pet.hero_id ?? '0') === heroId,
                'Repeat member pet binding is invalid',
                ErrorCode.PetNotExist,
            )
            seenPets.add(petId)
        }
        seen.add(heroId)
        slots.push({
            hero_id: heroId,
            pet_id: petId,
            hero_config_id: hero.conf_id,
            favor_eligible: eligibility.get(hero.conf_id) === 1,
        })
    }
    ensure(seen.size > 0, 'Repeat formation has no owned hero', ErrorCode.SetGroupNotSendHero)
    return { manager_type: 1, group_id: manager.cur_group, slots }
}
export function repeatFormationIsLocked(tables, state) {
    const run = state.entrust?.run
    if (run?.kind !== 'repeat' || run.map_id !== state.world.map_id) return false
    const route = repeatDungeon(tables, run.dungeon_id),
        city = route?.tables.find('world_city', run.map_id)
    // CheckIsDungeonScene06028a24 compares EWorldType.Dungeon (2). Do not
    // promote this rule to material/commission MultiDungeon (12).
    return city?.type === 2 && city.playModule === 'Dungeon'
}
export function captureRepeatFormation(state, run, now) {
    ensure(Number.isFinite(now) && now >= 0, 'Invalid repeat formation capture time', ErrorCode.GameConfig)
    return {
        version: 1,
        instance_id: run.instance_id,
        captured_at: Math.floor(now),
        source: 'verified-entry',
        ...roster(state),
    }
}
function matches(a, b) {
    const normalized = (value) => [
        value.manager_type,
        value.group_id,
        value.slots.map((slot) => [
            slot.hero_id,
            slot.pet_id,
            slot.hero_config_id ?? null,
            slot.favor_eligible ?? null,
        ]),
    ]
    return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b))
}
function verifiedSnapshot(run) {
    const saved = run.repeat_formation
    if (!saved) return null
    ensure(
        saved.version === 1 &&
            saved.source === 'verified-entry' &&
            saved.instance_id === run.instance_id &&
            Number.isSafeInteger(saved.captured_at) &&
            saved.captured_at >= 0 &&
            saved.manager_type === 1 &&
            Number.isSafeInteger(saved.group_id) &&
            saved.group_id >= 0 &&
            Array.isArray(saved.slots) &&
            saved.slots.length === 3,
        'Invalid saved repeat entry formation',
        ErrorCode.GameConfig,
    )
    ensure(
        saved.slots.every(
            (slot) =>
                slot &&
                typeof slot.hero_id === 'string' &&
                typeof slot.pet_id === 'string' &&
                (slot.hero_id === '0'
                    ? slot.pet_id === '0'
                    : Number.isSafeInteger(slot.hero_config_id) && typeof slot.favor_eligible === 'boolean'),
        ),
        'Invalid repeat entry member metadata',
        ErrorCode.GameConfig,
    )
    const ids = saved.slots.filter((slot) => slot.hero_id !== '0').map((slot) => slot.hero_id)
    const petIds = saved.slots.filter((slot) => slot.pet_id !== '0').map((slot) => slot.pet_id)
    ensure(
        ids.length > 0 && new Set(ids).size === ids.length && new Set(petIds).size === petIds.length,
        'Repeated saved repeat participants',
        ErrorCode.GameConfig,
    )
    ensure(
        [...ids, ...petIds].every((id) => /^\d+$/.test(id) && BigInt(id) > 0n && BigInt(id) <= 0xffffffffffffffffn),
        'Invalid saved repeat participant identity',
        ErrorCode.GameConfig,
    )
    return saved
}
export function repeatFormationBefore(tables, state) {
    if (!repeatFormationIsLocked(tables, state)) return null
    const run = state.entrust.run
    let current
    try {
        current = roster(state)
    } catch (error) {
        if (!(error instanceof GameError)) throw error
        // Do not trap a damaged old run before its quit/reentry handler can
        // remove it. If it remains active, post-validation still rejects it.
        current = null
    }
    return { instance_id: run.instance_id, map_id: run.map_id, roster: current }
}
export function validateRepeatFormation(tables, state, before) {
    if (!repeatFormationIsLocked(tables, state)) return
    const run = state.entrust.run,
        current = roster(state),
        saved = verifiedSnapshot(run)
    if (saved)
        ensure(
            matches(saved, current),
            'Formation members and pet bindings cannot change in this repeat dungeon',
            ErrorCode.InDungeon,
        )
    // Protect old active runs from future edits without fabricating the team
    // they originally entered with. Reenter creates a genuinely new snapshot.
    if (before?.roster && before.instance_id === run.instance_id && before.map_id === run.map_id)
        ensure(
            matches(before.roster, current),
            'Formation members and pet bindings cannot change in this repeat dungeon',
            ErrorCode.InDungeon,
        )
}
export function repeatEntryFavorCandidates(tables, state) {
    const run = state.entrust?.run
    if (run?.kind !== 'repeat') return { status: 'no-repeat-run', hero_guids: [] }
    const saved = verifiedSnapshot(run)
    if (!saved) return { status: 'legacy-entry-unverified', hero_guids: [] }
    for (const slot of saved.slots.filter((slot) => slot.hero_id !== '0')) {
        const hero = state.player.heros_info.heros.find((hero) => hero.guid === slot.hero_id)
        ensure(
            hero && !hero.trail && hero.conf_id === slot.hero_config_id,
            'Saved repeat participant is no longer an owned hero',
            ErrorCode.HeroNotExist,
        )
        ensure(
            eligibility.get(slot.hero_config_id) === (slot.favor_eligible ? 1 : 0),
            'Saved repeat favor eligibility is invalid',
            ErrorCode.GameConfig,
        )
    }
    return {
        status: 'verified-entry-candidates',
        instance_id: run.instance_id,
        hero_guids: saved.slots
            .filter((slot) => slot.hero_id !== '0' && slot.favor_eligible)
            .map((slot) => slot.hero_id),
    }
}
