import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Current AccessoryManager.AddRedot06029721 registers slots1..5 and
// CheckAccessorySlotReddot06029723 directly indexes HeroData's list atslot-1.
export const HERO_ACCESSORY_SLOT_COUNT = 5
const checked = new WeakSet()
export function repairHeroAccessorySlots(tables, state) {
    if (!checked.has(tables)) {
        const types = [...new Set(tables.get('accessory').map((row) => row.type))].sort((a, b) => a - b)
        ensure(
            types.length === HERO_ACCESSORY_SLOT_COUNT && types.every((type, index) => type === index + 1),
            'Current accessory slot directory does not match the client',
            ErrorCode.GameConfig,
        )
        checked.add(tables)
    }
    const heroes = state.player.heros_info.heros,
        planned = []
    for (const hero of heroes) {
        ensure(
            hero.oguid === undefined || Array.isArray(hero.oguid),
            'Saved hero accessory slot list is malformed',
            ErrorCode.GameConfig,
        )
        const prior = hero.oguid ?? []
        ensure(
            prior.every((guid) =>
                typeof guid === 'number'
                    ? Number.isInteger(guid) && guid >= 0 && guid <= 0xffffffff
                    : typeof guid === 'string' && /^\d+$/.test(guid) && BigInt(guid) <= 0xffffffffn,
            ),
            'Saved accessory slot binding is not a uint32 identifier',
            ErrorCode.GameConfig,
        )
        const slots = prior.map((guid) => (typeof guid === 'string' && BigInt(guid) === 0n ? 0 : guid))
        if (prior.length >= HERO_ACCESSORY_SLOT_COUNT && slots.every((guid, index) => guid === prior[index])) continue
        planned.push([hero, [...slots, ...Array(Math.max(0, HERO_ACCESSORY_SLOT_COUNT - prior.length)).fill(0)]])
    }
    // Validate the whole plan first. Preserve opaque equipment GUIDs and any
    // existing extended tail; absent/explicit-zero positions become slot0.
    for (const [hero, slots] of planned) hero.oguid = slots
    return planned.length > 0
}
