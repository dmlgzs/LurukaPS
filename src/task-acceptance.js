import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// TaskEntityStoryOpenTask.PlayStoryOver0602e783 accepts any end tag when
// configured tag<=0; a positive tag must match.6060 is emitted before the
// real-end callback that requests9850. The unrelated storyIds list is not proof.
export function taskAcceptStoryCompleted(state, storyId, requiredTag = 0) {
    if (!Number.isSafeInteger(storyId) || storyId <= 0 || !Number.isSafeInteger(requiredTag)) return false
    return Object.values(state.storyWatches ?? {}).some(
        (watch) =>
            watch?.story_id === storyId &&
            Number.isSafeInteger(watch.tag) &&
            (requiredTag <= 0 || watch.tag === requiredTag) &&
            Number.isSafeInteger(watch.story_type) &&
            watch.story_type >= 0 &&
            watch.story_type <= 4 &&
            Number.isSafeInteger(watch.last_time) &&
            watch.last_time > 0,
    )
}

// PetHaveCond2527 calls GetGainPetByGroupId: a currently owned permanent
// individual in this pet_rank group, not a count or an acquisition-history flag.
// Account-scoped Store ownership is retained for legacy UUIDs whose low32bits
// encode a sequence instead of the current native owner. No UUID is rewritten.
export function taskAcceptOwnedPetGroup(tables, state, groupId) {
    if (!tables || !Number.isSafeInteger(groupId) || groupId <= 0) return false
    const pets = state.pets ?? [],
        ranks = tables.get('pet_rank'),
        configs = new Set(ranks.filter((row) => row.petGroup === groupId).map((row) => row.petId)),
        transient = new Set()
    ensure(Array.isArray(pets), 'Invalid task acceptance pet inventory', ErrorCode.GameConfig)
    for (const list of [
        state.trialGroup?.pets,
        state.cultTrial?.pets,
        state.abyssRun?.pets,
        Object.values(state.kiboDuelTrialProfiles ?? {}),
    ]) {
        ensure(
            list === undefined || Array.isArray(list),
            'Invalid task acceptance temporary pets',
            ErrorCode.GameConfig,
        )
        for (const pet of list ?? []) transient.add(String(pet.guid))
    }
    return pets.some((pet) => {
        // Current PetType NORMAL=0/TRIAL=2;1 is retained only for saved legacy
        // normal profiles. Native permanent FightObjType2 is the GUID category.
        if (!pet || pet.trail || pet.trial || pet.is_trial || pet.abyss || ![undefined, 0, 1].includes(pet.type))
            return false
        const text = String(pet.guid ?? '')
        if (
            !/^[1-9]\d*$/.test(text) ||
            BigInt(text) > 0xffffffffffffffffn ||
            ![0n, 2n].includes(BigInt(text) >> 56n) ||
            transient.has(text)
        )
            return false
        // Optional local provenance is authoritative when present. These are
        // not claimed to be new PetbaseInfo wire fields.
        const owner = pet.owner_id ?? pet.player_id
        if (owner !== undefined && String(owner) !== '0' && String(owner) !== String(state.player.basic_info.id))
            return false
        return configs.has(pet.config_id) && !!tables.find('pet', pet.config_id)
    })
}
