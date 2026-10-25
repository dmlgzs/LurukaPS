import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/pet-initial-satiety-policy.json' with { type: 'json' }

const constants = new WeakMap()
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

export function initialPetSatiety(tables, configId, { temporary = false } = {}) {
    ensure(
        policy.version === 1 && policy.existingRecords === 'preserve',
        'Invalid pet satiety initialization policy',
        ErrorCode.GameConfig,
    )
    if (temporary) {
        ensure(
            policy.temporaryRecords === 'preserve-legacy-value' && uint(policy.temporaryValue),
            'Invalid temporary pet satiety policy',
            ErrorCode.GameConfig,
        )
        return policy.temporaryValue
    }
    if (!constants.has(tables)) {
        const rows = tables.get('game')
        const read = (key) => {
            const found = rows.filter((row) => row.title === key)
            ensure(
                found.length === 1 && /^\d+$/.test(String(found[0].value)),
                'Missing or malformed pet satiety constant',
                ErrorCode.GameConfig,
            )
            const value = Number(found[0].value)
            ensure(uint(value), 'Pet satiety constant exceeds its wire domain', ErrorCode.GameConfig)
            return value
        }
        const initial = read(policy.initialValueKey),
            maximum = read(policy.maximumValueKey)
        ensure(
            maximum > 0 && initial <= maximum,
            'Pet satiety beginning value exceeds configured maximum',
            ErrorCode.GameConfig,
        )
        constants.set(tables, { initial, maximum })
    }
    const { initial } = constants.get(tables)
    const home = tables.find('pet_home_talent', configId)
    if (home) {
        ensure(
            uint(home.satietyScore) && home.satietyScore > 0 && initial <= home.satietyScore,
            'Invalid home pet satiety maximum',
            ErrorCode.GameConfig,
        )
    }
    // Some catchable/trial pets have no home labor profile. Their creation
    // still uses the shared configured initial value; do not fabricate labor.
    return initial
}
