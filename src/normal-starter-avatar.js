import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { starterProfileMode } from './starter-profile.js'

const uint = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const nonzero = (value) => value !== undefined && value !== null && value !== 0 && value !== '0'
function avatarId(tables, sex) {
    ensure([1, 2].includes(sex), 'Invalid protagonist sex', ErrorCode.InvalidArgument)
    const key = sex === 1 ? 'AVATAR_HERO_ID_MALE' : 'AVATAR_HERO_ID_FEMALE'
    const value = tables.get('game').filter((row) => row.title === key)
    const id = value.length === 1 ? Number(value[0].value) : NaN
    ensure(uint(id) && tables.find('hero', id), 'Normal protagonist configuration unavailable', ErrorCode.GameConfig)
    return id
}
function source(tables, state) {
    const marker = state.normalStarterAvatar
    ensure(
        object(marker) &&
            marker.version === 1 &&
            ['provisional', 'selected'].includes(marker.phase) &&
            [1, 2].includes(marker.sex),
        'Normal protagonist marker unavailable',
        ErrorCode.GameConfig,
    )
    const owner = state.player?.basic_info?.id
    ensure(
        uint(owner) && typeof marker.guid === 'string' && /^[1-9]\d*$/.test(marker.guid),
        'Normal protagonist owner malformed',
        ErrorCode.GameConfig,
    )
    const guid = BigInt(marker.guid)
    const origin = avatarId(tables, 2)
    const avatarIds = [origin, avatarId(tables, 1)]
    ensure(avatarIds[0] !== avatarIds[1], 'Normal protagonist configurations are duplicated', ErrorCode.GameConfig)
    ensure(
        guid === ((1n << 56n) | (BigInt(origin) << 32n) | BigInt(owner)) &&
            marker.configId === avatarId(tables, marker.sex),
        'Normal protagonist identity differs from factory persona',
        ErrorCode.GameConfig,
    )
    if (marker.phase === 'provisional') {
        ensure(
            marker.sex === 2 && !state.characterCustomized,
            'Normal provisional protagonist already customized',
            ErrorCode.GameConfig,
        )
    } else {
        ensure(
            marker.identityPolicy === 'normal-avatar-persona-v1' &&
                marker.originConfigId === origin &&
                Number.isSafeInteger(marker.selectionRevision) &&
                marker.selectionRevision > 0,
            'Normal selected protagonist identity malformed',
            ErrorCode.GameConfig,
        )
    }
    const heroes = state.player.heros_info?.heros
    ensure(Array.isArray(heroes), 'Normal protagonist ownership unavailable', ErrorCode.GameConfig)
    const own = heroes.filter((row) => row.guid === marker.guid)
    ensure(
        state.player.basic_info.sex === marker.sex &&
            own.length === 1 &&
            own[0].conf_id === marker.configId &&
            own[0].type === 1 &&
            !own[0].trail &&
            !own[0].abyss &&
            heroes.filter((row) => row.type === 1).length === 1,
        'Normal protagonist owned identity malformed',
        ErrorCode.GameConfig,
    )
    ensure(
        heroes.filter((hero) => hero.conf_id === marker.configId).length === 1,
        'Normal protagonist owned configuration is duplicated',
        ErrorCode.GameConfig,
    )
    ensure(
        !heroes.some((hero) => hero.guid !== marker.guid && avatarIds.includes(hero.conf_id)),
        'Normal protagonist persona overlaps a distinct owned avatar',
        ErrorCode.FunctionClosed,
    )
    return { marker, actor: own[0], heroes, avatarIds }
}

// Two current presentation configs describe the ONE validated normal persona.
// Acquisition callers may avoid issuing a second avatar; this is not another
// owned row, a GUID alias, or an exemption for legacy/sandbox ownership.
export function normalStarterAvatarOwnedConfigIds(tables, state) {
    if (starterProfileMode(state) !== 'normal') return []
    return [...source(tables, state).avatarIds].sort((a, b) => a - b)
}
function validateBindings(state, actor) {
    const id = actor.guid
    const souls = state.player.soulessence_infos?.soulessences ?? []
    const ornaments = state.ornaments ?? []
    const pets = state.pets ?? []
    ensure(
        Array.isArray(souls) && Array.isArray(ornaments) && Array.isArray(pets),
        'Normal protagonist asset bindings malformed',
        ErrorCode.GameConfig,
    )
    const bound = (list, guid, field) =>
        list.filter((row) => String(row.guid) === String(guid) && row[field] === id).length === 1
    if (nonzero(actor.wguid))
        ensure(bound(souls, actor.wguid, 'wear_hero'), 'Normal protagonist soul binding differs', ErrorCode.GameConfig)
    ensure(Array.isArray(actor.oguid ?? []), 'Normal protagonist ornament slots malformed', ErrorCode.GameConfig)
    for (const guid of actor.oguid ?? [])
        if (nonzero(guid))
            ensure(
                bound(ornaments, guid, 'wear_hero'),
                'Normal protagonist ornament binding differs',
                ErrorCode.GameConfig,
            )
    if (nonzero(actor.pet_id))
        ensure(
            bound(pets, actor.pet_id, 'hero_id'),
            'Normal protagonist companion binding differs',
            ErrorCode.GameConfig,
        )
    const groups = state.player.group_mgrs
    ensure(Array.isArray(groups), 'Normal protagonist formations unavailable', ErrorCode.GameConfig)
    for (const manager of groups) {
        ensure(Array.isArray(manager.groups), 'Normal protagonist formation groups malformed', ErrorCode.GameConfig)
        for (const group of manager.groups) {
            ensure(Array.isArray(group.heros), 'Normal protagonist formation slots malformed', ErrorCode.GameConfig)
            if (group.control === id)
                ensure(
                    group.heros.some((slot) => slot.hero_id === id),
                    'Normal protagonist control is not in formation',
                    ErrorCode.GameConfig,
                )
        }
    }
    const battle = state.player.heros_info.battle_infos ?? []
    ensure(
        Array.isArray(battle) && battle.filter((row) => row.hero_id === id).length <= 1,
        'Normal protagonist battle identity duplicated',
        ErrorCode.GameConfig,
    )
    for (const row of battle.filter((row) => row.hero_id === id))
        ensure(
            Number.isInteger(row.hp) && row.hp >= 0 && Number.isInteger(row.sp) && row.sp >= 0,
            'Normal protagonist battle vitals malformed',
            ErrorCode.GameConfig,
        )
}
function validatePending(state, id) {
    const combat = state.combat
    ensure(
        !Object.values(combat?.skills ?? {}).some((row) => row.unit_id === id) &&
            !Object.values(combat?.bullets ?? {}).some((row) => row.unit_id === id) &&
            !Object.values(combat?.elements ?? {}).some(
                (row) =>
                    row.tar_id === id ||
                    ['attacker_id', 'executor_id', 'source_id', 'creator_id'].some((key) => row.buff?.[key] === id),
            ) &&
            !state.medicine?.tracked?.[id],
        'Protagonist appearance change has pending actor execution',
        ErrorCode.FunctionClosed,
    )
    // Historical receipts remain byte-for-byte intact. These active snapshot
    // contexts need their own lifecycle proof before changing their config.
    ensure(
        !state.abyssRun?.heroAttrs?.[id] &&
            !state.cultTrial?.heroes?.some((hero) => hero.guid === id) &&
            state.npcArenaTrialTrainer?.hero?.guid !== id,
        'Protagonist appearance change has pending actor snapshot',
        ErrorCode.FunctionClosed,
    )
}

// LOCAL normal factory persona policy, grounded in current non-trial
// HeroData.SetConfigIds(06029d61), Populate(06029d6c), CheckHeroData(06029d39)
// and CreateHeroEntity(06029ab9). Owned GUID/refs remain stable; conf_id is
// independent current presentation data. Never grant/delete another hero.
export function selectNormalStarterAvatar(tables, state, sex) {
    if (starterProfileMode(state) !== 'normal') return null
    const { marker, actor, heroes } = source(tables, state)
    const configId = avatarId(tables, sex)
    const changed = configId !== actor.conf_id
    if (changed || marker.phase === 'provisional') validateBindings(state, actor)
    if (changed) {
        ensure(
            !heroes.some((row) => row.guid !== actor.guid && row.conf_id === configId),
            'Protagonist target already belongs to a distinct owned hero',
            ErrorCode.FunctionClosed,
        )
        validatePending(state, actor.guid)
        ensure(
            !nonzero(actor.hero_skin) || actor.hero_skin === actor.conf_id,
            'Protagonist custom skin cannot change sex without a mapping',
            ErrorCode.FunctionClosed,
        )
    }
    const skin = tables.get('hero_clothing').filter((row) => row.clothingid === configId)
    ensure(
        skin.length === 1 && skin[0].hero === configId && uint(skin[0].unitId),
        'Protagonist default clothing unavailable',
        ErrorCode.GameConfig,
    )
    const replacement = changed
        ? {
              ...actor,
              conf_id: configId,
              type: 1,
              trail: false,
              ...(nonzero(actor.hero_skin) ? { hero_skin: configId } : {}),
          }
        : actor
    if (changed)
        state.player = {
            ...state.player,
            heros_info: { ...state.player.heros_info, heros: heroes.map((row) => (row === actor ? replacement : row)) },
        }
    if (changed || marker.phase === 'provisional')
        state.normalStarterAvatar = {
            ...marker,
            phase: 'selected',
            sex,
            configId,
            identityPolicy: 'normal-avatar-persona-v1',
            originConfigId: avatarId(tables, 2),
            selectionRevision: (marker.selectionRevision ?? 0) + 1,
        }
    return { changed, initialized: marker.phase === 'provisional', heroGuid: actor.guid, configId }
}
