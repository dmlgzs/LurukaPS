import policy from '../configs/world-interaction-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function worldInteractionRange(baseCm, { hud = false } = {}) {
    ensure(
        policy.version === 1 && Number.isSafeInteger(policy.distanceToleranceCm) && policy.distanceToleranceCm >= 0,
        'LOCAL world interaction tolerance configuration invalid',
        ErrorCode.GameConfig,
    )
    ensure(Number.isFinite(baseCm) && baseCm > 0, 'World interaction range invalid', ErrorCode.GameConfig)
    // CBT3 WorldInteractHudField.UpdateField (06024b3f) adds ten metres.
    // Intro buttons can invoke interaction from that HUD field. Matching it is
    // client-derived compatibility; the extra tolerance is a separate LOCAL policy.
    return baseCm + (hud ? 1000 : 0) + policy.distanceToleranceCm
}
