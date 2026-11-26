import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { activateCombatGroup } from './combat-enemy-lifecycle.js'

// All four admitted scene-run producers assign instance_id. Older persisted
// runs used the existing dungeon/start-time tuple; retain that stable identity
// rather than minting one from the clock on each login/projection.
export function activateSceneCombatGroup(state, run, row, packs, { kind, phase, active, now }) {
    const positive = (value) => Number.isSafeInteger(value) && value > 0
    const identity = positive(run.instance_id)
        ? ['instance', run.instance_id]
        : ['legacy-run', run.dungeon_id, run.start_time]
    ensure(
        typeof kind === 'string' &&
            kind.length > 0 &&
            positive(run.map_id) &&
            positive(row.id) &&
            (positive(run.instance_id) || (positive(run.dungeon_id) && positive(run.start_time))) &&
            typeof phase === 'string' &&
            phase.length > 0 &&
            Number.isSafeInteger(now) &&
            now >= 0,
        'Scene combat activation identity is unavailable',
        ErrorCode.GameConfig,
    )
    return activateCombatGroup(state, {
        root: ((3n << 56n) | BigInt(row.id)).toString(),
        scopeKey: JSON.stringify([kind, identity, run.map_id, row.id, phase]),
        packIds: packs.map(Number),
        active,
        activatedAtMs: BigInt(now) * 1000n,
        adoptExisting: true,
    })
}
