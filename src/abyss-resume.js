import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { heroBattleLimits } from './battle.js'
const signature = (parts) =>
    JSON.stringify(
        parts.map((x) => ({
            dungeon_id: x.dungeon_id,
            buff_id: x.buff_id,
            heros: x.heros.map((h) => ({ index: h.index, hero: h.hero })),
        })),
    )
export function validateAbyssCheckpoint(checkpoint, roster, level, rotation) {
    if (!checkpoint) return null
    ensure(
        checkpoint.version === 1 &&
            checkpoint.mode === level.mode &&
            checkpoint.level_id === level.id &&
            checkpoint.rotation_id === (rotation?.id ?? 0),
        'Saved abyss checkpoint identity is invalid',
        ErrorCode.GameConfig,
    )
    const parts = checkpoint.challenges
    ensure(
        Array.isArray(parts) &&
            parts.length === roster.challenges.length &&
            checkpoint.completed_parts > 0 &&
            checkpoint.completed_parts < parts.length &&
            parts.every((x, i) => x.win === i < checkpoint.completed_parts) &&
            parts.every((x) => Number.isSafeInteger(x.battle_time) && x.battle_time >= 0) &&
            checkpoint.total_battle_time ===
                parts.slice(0, checkpoint.completed_parts).reduce((s, x) => s + x.battle_time, 0),
        'Saved abyss checkpoint progress is invalid',
        ErrorCode.GameConfig,
    )
    ensure(
        signature(parts) === signature(roster.challenges),
        'Reset abyss progress before changing locked teams or buffs',
        ErrorCode.AbyssInvalidTroop,
    )
    for (const [field, attrs, kind] of [
        ['heroes', 'heroAttrs', 30],
        ['pets', 'petAttrs', 31],
    ]) {
        const expected = new Map(roster[field].map((x) => [x.guid, x.source_guid])),
            records = checkpoint[field]
        ensure(
            Array.isArray(records) &&
                records.length === expected.size &&
                new Set(records.map((x) => x.guid)).size === records.length,
            'Saved abyss actor roster is invalid',
            ErrorCode.GameConfig,
        )
        for (const actor of records) {
            ensure(
                actor.abyss === true &&
                    actor.source_guid === expected.get(actor.guid) &&
                    BigInt(actor.guid) >> 56n === BigInt(kind) &&
                    checkpoint[attrs]?.[actor.guid]?.hero_guid === actor.guid,
                'Saved abyss actor snapshot is invalid',
                ErrorCode.GameConfig,
            )
            heroBattleLimits(checkpoint[attrs][actor.guid])
        }
    }
    const heroIds = new Set(checkpoint.heroes.map((x) => x.guid))
    ensure(
        Array.isArray(checkpoint.dead_hero_ids) && checkpoint.dead_hero_ids.every((x) => heroIds.has(x)),
        'Saved abyss fallen hero ledger is invalid',
        ErrorCode.GameConfig,
    )
    for (const part of parts)
        for (const row of part.heros) {
            for (const [id, hp, field] of [
                [row.hero.hero_guid, row.hp, 'heroAttrs'],
                [row.hero.pet_guid, row.pet_hp, 'petAttrs'],
            ])
                ensure(
                    id === '0'
                        ? hp === 0
                        : Number.isSafeInteger(hp) && hp >= 0 && hp <= heroBattleLimits(checkpoint[field][id]).hp,
                    'Saved abyss actor health is invalid',
                    ErrorCode.GameConfig,
                )
        }
    return checkpoint
}
export function restoreAbyssCheckpoint(state, run, checkpoint) {
    if (!checkpoint) return
    for (const field of ['heroes', 'pets', 'heroAttrs', 'petAttrs', 'challenges', 'dead_hero_ids'])
        run[field] = structuredClone(checkpoint[field])
    run.part_index = checkpoint.completed_parts
    run.total_battle_time = checkpoint.total_battle_time
    run.map_id = run.rooms[run.part_index].map_id
    run.dungeon_id = run.rooms[run.part_index].dungeon_id
    run.last_transition = 'resume'
    const ids = new Set(run.heroes.map((x) => x.guid))
    state.player.heros_info.battle_infos = state.player.heros_info.battle_infos.filter((x) => !ids.has(x.hero_id))
    run.pet_hp = {}
    for (const part of run.challenges)
        for (const row of part.heros) {
            if (row.hero.hero_guid !== '0')
                state.player.heros_info.battle_infos.push({
                    hero_id: row.hero.hero_guid,
                    hp: row.hp,
                    sp: heroBattleLimits(run.heroAttrs[row.hero.hero_guid]).sp,
                    alive_state: row.hp > 0 ? 0 : 1,
                })
            if (row.hero.pet_guid !== '0') run.pet_hp[row.hero.pet_guid] = row.pet_hp
        }
}
