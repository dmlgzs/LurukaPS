import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// A pet remains reserved while a real trip is running OR ready but unclaimed.
// The UI mirror tour_state is not authoritative and the event window may end.
export function petInKiboTour(state, guid) {
    const id = String(guid)
    for (const [activityId, entry] of Object.entries(state.activities ?? {})) {
        const ledger = entry.kiboTour
        if (!ledger) continue
        ensure(
            ledger.runs && typeof ledger.runs === 'object' && !Array.isArray(ledger.runs),
            'Saved Kibo tour ledger is malformed',
            ErrorCode.GameConfig,
        )
        for (const run of Object.values(ledger.runs)) {
            ensure(
                run && [0, 1, 2].includes(run.state) && Array.isArray(run.pet_ids),
                'Saved Kibo tour reservation is malformed',
                ErrorCode.GameConfig,
            )
            if (run.state !== 2 && run.pet_ids.some((value) => String(value) === id))
                return { activity_id: Number(activityId), run }
        }
    }
    return null
}

export function ensurePetNotInKiboTour(state, guid) {
    ensure(!petInKiboTour(state, guid), 'Pet belongs to an unfinished Kibo tour', ErrorCode.ActivityPetTourCannotDel)
}
