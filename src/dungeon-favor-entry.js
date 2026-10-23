import { activeFormationManager, temporaryHeroes } from './trial-actors.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const guid = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 0xffffffffffffffffn
const kindOf = (run) => run.kind ?? 'entrust'
function trialHeroes(state) {
    for (const rows of [state.trialGroup?.heroes, state.cultTrial?.heroes])
        ensure(
            rows === undefined || Array.isArray(rows),
            'Malformed dungeon temporary hero ownership',
            ErrorCode.GameConfig,
        )
    return temporaryHeroes(state)
}
function qualification(tables, id) {
    const rows = tables.get('hero').filter((row) => row.id === id)
    ensure(
        rows.length === 1 && [0, 1].includes(rows[0].favor),
        'Dungeon entry hero favor configuration is missing or malformed',
        ErrorCode.GameConfig,
    )
    return rows[0].favor === 1
}

// Captured exactly once after entry worldSync has restored expired formations.
// This records reward recipients; it does not lock type12 teams or pet bindings.
export function captureDungeonFavorEntry(tables, state, run, now) {
    ensure(['material', 'entrust'].includes(kindOf(run)), 'Unsupported dungeon favor entry kind', ErrorCode.GameConfig)
    const manager = activeFormationManager(state),
        group = manager?.groups?.find((row) => row.id === manager.cur_group)
    ensure(
        group && Array.isArray(group.heros) && group.heros.length > 0 && group.heros.length <= 3,
        'Dungeon entry formation unavailable',
        ErrorCode.GameConfig,
    )
    const members = [],
        seen = new Set(),
        trial = trialHeroes(state)
    for (const [slotIndex, slot] of group.heros.entries()) {
        const id = String(slot.hero_id ?? '0')
        if (id === '0') continue
        ensure(guid(id) && !seen.has(id), 'Invalid or duplicate dungeon entry hero identity', ErrorCode.GameConfig)
        seen.add(id)
        const owned = state.player.heros_info.heros.filter((hero) => hero.guid === id),
            temporary = trial.find((hero) => hero?.guid === id)
        ensure(owned.length <= 1, 'Duplicate owned dungeon entry identity', ErrorCode.GameConfig)
        const hero = owned[0] ?? temporary
        ensure(
            hero && uint(hero.conf_id) && hero.conf_id > 0,
            'Dungeon entry hero is not available',
            ErrorCode.HeroNotExist,
        )
        ensure(
            hero.trail === undefined || typeof hero.trail === 'boolean',
            'Malformed dungeon entry hero trial flag',
            ErrorCode.GameConfig,
        )
        const permanent = !!owned[0] && !hero.trail && !temporary
        members.push({
            slot_index: slotIndex,
            hero_guid: id,
            hero_config_id: hero.conf_id,
            owned: permanent,
            favor_eligible: permanent ? qualification(tables, hero.conf_id) : false,
        })
    }
    ensure(
        members.length > 0 && Number.isFinite(now) && now >= 0,
        'Invalid dungeon favor entry metadata',
        ErrorCode.GameConfig,
    )
    return {
        version: 1,
        source: 'verified-local-dungeon-entry',
        owner_id: state.player.basic_info.id,
        instance_id: run.instance_id,
        dungeon_id: run.dungeon_id,
        map_id: run.map_id,
        run_kind: kindOf(run),
        captured_at: Math.floor(now),
        manager_type: manager.type,
        group_id: group.id,
        members,
    }
}

export function dungeonEntryFavorCandidates(tables, state) {
    const run = state.entrust?.run
    if (!run || !['material', 'entrust'].includes(kindOf(run)))
        return { status: 'no-local-dungeon-run', hero_guids: [] }
    const entry = run.favor_entry
    if (!entry) return { status: 'legacy-entry-unverified', hero_guids: [] }
    ensure(
        entry.version === 1 &&
            entry.source === 'verified-local-dungeon-entry' &&
            entry.owner_id === state.player.basic_info.id &&
            uint(entry.owner_id) &&
            entry.owner_id > 0 &&
            entry.instance_id === run.instance_id &&
            uint(entry.instance_id) &&
            entry.instance_id > 0 &&
            entry.dungeon_id === run.dungeon_id &&
            entry.map_id === run.map_id &&
            entry.run_kind === kindOf(run) &&
            uint(entry.captured_at) &&
            uint(entry.manager_type) &&
            uint(entry.group_id) &&
            Array.isArray(entry.members) &&
            entry.members.length > 0 &&
            entry.members.length <= 3,
        'Invalid saved dungeon favor entry',
        ErrorCode.GameConfig,
    )
    const seen = new Set(),
        slots = new Set(),
        trials = trialHeroes(state)
    for (const member of entry.members) {
        ensure(
            member &&
                guid(member.hero_guid) &&
                !seen.has(member.hero_guid) &&
                uint(member.slot_index) &&
                member.slot_index < 3 &&
                !slots.has(member.slot_index) &&
                uint(member.hero_config_id) &&
                member.hero_config_id > 0 &&
                typeof member.owned === 'boolean' &&
                typeof member.favor_eligible === 'boolean' &&
                (member.owned || !member.favor_eligible),
            'Invalid saved dungeon entry member',
            ErrorCode.GameConfig,
        )
        seen.add(member.hero_guid)
        slots.add(member.slot_index)
        if (!member.owned) continue
        const owned = state.player.heros_info.heros.filter((hero) => hero.guid === member.hero_guid)
        ensure(owned.length > 0, 'Dungeon entry reward hero is no longer owned', ErrorCode.HeroNotExist)
        ensure(
            owned.length === 1 && owned[0].conf_id === member.hero_config_id,
            'Dungeon entry hero identity changed',
            ErrorCode.GameConfig,
        )
        ensure(
            owned[0].trail === undefined || typeof owned[0].trail === 'boolean',
            'Malformed saved dungeon hero trial flag',
            ErrorCode.GameConfig,
        )
        ensure(
            !owned[0].trail && !trials.some((hero) => hero?.guid === member.hero_guid),
            'Dungeon entry reward hero became temporary',
            ErrorCode.HeroFavorExpLocked,
        )
        const eligible = qualification(tables, member.hero_config_id)
        ensure(
            eligible === member.favor_eligible,
            'Dungeon entry hero favor qualification changed',
            member.favor_eligible ? ErrorCode.HeroFavorExpLocked : ErrorCode.GameConfig,
        )
    }
    return {
        status: 'verified-entry-candidates',
        instance_id: run.instance_id,
        hero_guids: entry.members
            .filter((member) => member.owned && member.favor_eligible)
            .map((member) => member.hero_guid),
    }
}
