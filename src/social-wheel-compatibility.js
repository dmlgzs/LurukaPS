import compatibility from '../configs/social-wheel-compatibility.json' with { type: 'json' }
import { socialActionIdentity, socialActionFingerprint } from './social-wheel-identity.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const models = new WeakMap()
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
function model(tables) {
    if (models.has(tables)) return models.get(tables)
    const rows = tables.get('social_wheel'),
        actions = socialActionIdentity(rows),
        ids = new Set(rows.map((row) => row.id))
    ensure(
        compatibility.schemaVersion === 1 &&
            compatibility.scope === 'saved-social-wheel-action-identities-only' &&
            compatibility.source?.clientVersion === 'CBT3' &&
            compatibility.target?.clientVersion === '1.0.0' &&
            compatibility.target.packageVersion === '3217420' &&
            compatibility.target.catalogVersion === '1.0.0/3217420' &&
            /^[a-f0-9]{64}$/.test(compatibility.source.tableSha256) &&
            socialActionFingerprint(rows) === compatibility.target.actionFingerprint &&
            Array.isArray(compatibility.mappings) &&
            compatibility.mappings.every(
                (entry) =>
                    entry &&
                    positive(entry.from) &&
                    positive(entry.to) &&
                    !ids.has(entry.from) &&
                    actions.some((row) => row.id === entry.to && row.action === entry.action),
            ) &&
            new Set(compatibility.mappings.map((row) => row.from)).size === compatibility.mappings.length &&
            new Set(compatibility.mappings.map((row) => row.to)).size === compatibility.mappings.length,
        'Social wheel compatibility does not match the current action catalogue',
        ErrorCode.GameConfig,
    )
    const result = {
        version: compatibility.target.catalogVersion,
        mappings: new Map(compatibility.mappings.map((row) => [row.from, row.to])),
    }
    models.set(tables, result)
    return result
}

// Pure projection: read-only visual requests must not mutate borrowed state.
// Only absent-version, proven old IDs that do not exist currently may migrate.
export function projectSavedSocialWheel(tables, data, slots) {
    const current = model(tables)
    ensure(
        data?.catalogVersion === undefined || data.catalogVersion === current.version,
        'Unsupported saved social wheel catalogue version',
        ErrorCode.GameConfig,
    )
    if (data?.catalogVersion === current.version) return { slots, version: current.version, needsWrite: false }
    const converted = slots.map((row) => ({ ...row, id: current.mappings.get(row.id) ?? row.id }))
    const changed = slots.some((row, index) => row.id !== converted[index].id)
    return {
        slots: converted,
        version: current.version,
        needsWrite: true,
        ...(changed && data?.legacyCatalog === undefined
            ? {
                  legacyCatalog: {
                      sourceClient: compatibility.source.clientVersion,
                      sourceTableSha256: compatibility.source.tableSha256,
                      slots: slots.map((row) => ({ ...row })),
                  },
              }
            : {}),
    }
}
