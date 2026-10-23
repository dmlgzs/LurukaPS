import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { heroModules, heroBattleLimits, petModules } from './battle.js'
const LOW56 = (1n << 56n) - 1n
export const abyssHeroGuid = (id) => ((30n << 56n) | (BigInt(id) & LOW56)).toString()
export const abyssPetGuid = (id) => ((31n << 56n) | (BigInt(id) & LOW56)).toString()
function parsedGuid(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
    if (!['string', 'number', 'bigint'].includes(typeof value)) return null
    const text = String(value)
    if (!/^(0|[1-9]\d*)$/.test(text)) return null
    const id = BigInt(text)
    return id < 1n << 64n ? id : null
}
function ownedResolver(state, kind, copyKind) {
    const field = kind === 1 ? 'heroes' : 'pets'
    const temporary = new Set(
        [
            ...(state.trialGroup?.[field] ?? []),
            ...(state.cultTrial?.[field] ?? []),
            ...(kind === 1 && state.npcArenaTrialTrainer?.hero ? [state.npcArenaTrialTrainer.hero] : []),
        ].map((actor) => String(actor.guid)),
    )
    const actors = kind === 1 ? state.player.heros_info.heros : state.pets
    const exact = new Map(),
        copies = new Map()
    for (const actor of actors) {
        const id = parsedGuid(actor.guid)
        if (
            id === null ||
            id === 0n ||
            temporary.has(String(actor.guid)) ||
            actor.trail ||
            actor.trial ||
            actor.is_trial ||
            actor.abyss ||
            actor.type === 2
        )
            continue
        const type = Number(id >> 56n)
        if (type !== 0 && type !== kind) continue
        const source = id.toString(),
            copy = ((BigInt(copyKind) << 56n) | (id & LOW56)).toString()
        const matching = copies.get(copy) ?? []
        matching.push(source)
        copies.set(copy, matching)
        exact.set(source, actor)
    }
    return (value) => {
        const id = parsedGuid(value ?? '0')
        ensure(id !== null, 'Invalid abyss actor identity', ErrorCode.AbyssInvalidTroop)
        if (id === 0n) return '0'
        const type = Number(id >> 56n),
            key = id.toString()
        ensure(
            type === 0 || type === kind || type === copyKind,
            'Invalid abyss actor type',
            ErrorCode.AbyssInvalidTroop,
        )
        const copy = ((BigInt(copyKind) << 56n) | (id & LOW56)).toString(),
            candidates = copies.get(copy)
        // Legacy IDs are admitted only by an exact permanent record. Typed
        // requests never fall back to another low56 source. FO30/31 round trips
        // require a unique real source; a typed/legacy collision is ambiguous
        // even when only one of those actors was selected in this request.
        const source = type === copyKind ? candidates?.[0] : exact.has(key) ? key : null
        ensure(source && candidates?.length === 1, 'Abyss actor is not uniquely owned', ErrorCode.AbyssInvalidTroop)
        return source
    }
}
export function abyssChallengeRoster(tables, state, level, request) {
    const dungeonIds = String(level.dungeonId).split('|').map(Number),
        nodes = request.challenge_list
    ensure(
        Array.isArray(nodes) && nodes.length === dungeonIds.length,
        'Missing abyss challenge teams',
        ErrorCode.AbyssNoChallengeList,
    )
    ensure(level.team === nodes.length, 'Abyss team configuration differs', ErrorCode.AbyssInvalidTroop)
    const heroes = [],
        pets = [],
        heroAttrs = {},
        petAttrs = {},
        usedHeroes = new Set(),
        usedPets = new Set(),
        challenges = [],
        ownedHero = ownedResolver(state, 1, 30),
        ownedPet = ownedResolver(state, 2, 31)
    for (let part = 0; part < nodes.length; part++) {
        const node = nodes[part]
        if (level.mode !== 3)
            ensure(!node.buff_id, 'This abyss mode does not accept a team buff selection', ErrorCode.AbyssInvalidTroop)
        else {
            const groupId = Number(String(level.buffGroupid).split('|')[part]),
                group = tables.find('abbys_buff_group', groupId)
            ensure(
                group &&
                    String(group.buffList).split('|').map(Number).includes(node.buff_id) &&
                    tables.find('abbys_buff', node.buff_id),
                'Abyss team buff is not in the configured selection group',
                ErrorCode.AbyssInvalidTroop,
            )
        }
        ensure(
            node.dungeon_id === dungeonIds[part],
            'Abyss challenge dungeon order differs',
            ErrorCode.AbyssInvalidDungeonID,
        )
        ensure(
            Array.isArray(node.heros) && node.heros.length === 3,
            'Abyss teams require exactly three indexed slots',
            ErrorCode.AbyssHeroNumLimit,
        )
        const indices = new Set(),
            slots = []
        for (const unit of node.heros) {
            ensure(
                Number.isInteger(unit.index) && unit.index >= 0 && unit.index < 3 && !indices.has(unit.index),
                'Invalid abyss team slot',
                ErrorCode.AbyssInvalidTroop,
            )
            indices.add(unit.index)
            const sourceHero = ownedHero(unit.hero?.hero_guid),
                sourcePet = ownedPet(unit.hero?.pet_guid)
            if (sourceHero === '0') {
                ensure(sourcePet === '0', 'Abyss pet has no team hero', ErrorCode.AbyssInvalidTroop)
                slots.push({ index: unit.index, hero: { hero_guid: '0', pet_guid: '0' }, hp: 0, pet_hp: 0 })
                continue
            }
            const original = state.player.heros_info.heros.find((x) => String(x.guid) === sourceHero)
            ensure(original, 'Abyss hero is not owned', ErrorCode.AbyssInvalidTroop)
            ensure(!usedHeroes.has(sourceHero), 'Abyss hero repeated across teams', ErrorCode.AbyssHeroRepeated)
            usedHeroes.add(sourceHero)
            const guid = abyssHeroGuid(sourceHero),
                hero = {
                    ...structuredClone(original),
                    guid,
                    source_guid: sourceHero,
                    abyss: true,
                    pet_id: sourcePet === '0' ? '0' : abyssPetGuid(sourcePet),
                },
                attributes = heroModules(tables, state, original),
                limits = heroBattleLimits(attributes)
            attributes.hero_guid = guid
            attributes.type = 30
            heroAttrs[guid] = attributes
            heroes.push(hero)
            let petHp = 0
            if (sourcePet !== '0') {
                const originalPet = state.pets.find((x) => String(x.guid) === sourcePet)
                ensure(originalPet, 'Abyss pet is not owned', ErrorCode.AbyssInvalidTroop)
                ensure(!usedPets.has(sourcePet), 'Abyss pet repeated across teams', ErrorCode.AbyssPetRepeated)
                usedPets.add(sourcePet)
                const petGuid = abyssPetGuid(sourcePet),
                    pet = {
                        ...structuredClone(originalPet),
                        guid: petGuid,
                        source_guid: sourcePet,
                        hero_id: guid,
                        abyss: true,
                    },
                    sourceView = { ...originalPet, hero_id: guid },
                    mods = petModules(tables, state, sourceView, [attributes])
                mods.hero_guid = petGuid
                mods.type = 31
                petAttrs[petGuid] = mods
                pets.push(pet)
                // HP comes from the selected actor's actual modules, never a
                // request field or a fabricated constant.
                petHp = heroBattleLimits(mods).hp
            }
            slots.push({
                index: unit.index,
                hero: { hero_guid: guid, pet_guid: hero.pet_id },
                hp: limits.hp,
                pet_hp: petHp,
            })
        }
        ensure(
            slots.some((x) => x.hero.hero_guid !== '0'),
            'Abyss team has no hero',
            ErrorCode.AbyssHeroEmpty,
        )
        const sourceControl = ownedHero(node.control),
            control = sourceControl === '0' ? '0' : abyssHeroGuid(sourceControl)
        ensure(
            slots.some((x) => x.hero.hero_guid === control && control !== '0'),
            'Abyss control hero is not in the team',
            ErrorCode.AbyssInvalidTroop,
        )
        challenges.push({
            dungeon_id: node.dungeon_id,
            control,
            heros: slots.sort((a, b) => a.index - b.index),
            buff_id: node.buff_id ?? 0,
            win: false,
            battle_time: 0,
            dead_hero_num: 0,
            protect_enemy_list: [],
        })
    }
    return { heroes, pets, heroAttrs, petAttrs, challenges }
}
