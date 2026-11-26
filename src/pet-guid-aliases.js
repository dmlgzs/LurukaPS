import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { petGuidOwner, parsePetGuid, isCanonicalPetGuid } from './pet-guid.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
export function petIdentityMigration(state) {
    const saved = state.petGuidMigration
    if (saved === undefined) return null
    const owner = petGuidOwner(state)
    ensure(
        object(saved) &&
            saved.version === 1 &&
            saved.ownerId === owner &&
            object(saved.aliases) &&
            object(saved.pendingLinks),
        'Malformed pet identity migration',
        ErrorCode.GameConfig,
    )
    const targets = new Set()
    for (const [old, current] of Object.entries(saved.aliases)) {
        const source = parsePetGuid(old)
        ensure(
            source.guid === old &&
                source.guid !== '0' &&
                typeof current === 'string' &&
                parsePetGuid(current).guid === current &&
                old !== current &&
                !Object.hasOwn(saved.aliases, current) &&
                [0, 2].includes(source.type) &&
                isCanonicalPetGuid(current, owner) &&
                !targets.has(current),
            'Invalid or ambiguous migrated pet identity',
            ErrorCode.GameConfig,
        )
        targets.add(current)
    }
    for (const [current, links] of Object.entries(saved.pendingLinks)) {
        ensure(
            isCanonicalPetGuid(current, owner) && object(links),
            'Invalid mutation identity link owner',
            ErrorCode.GameConfig,
        )
        for (const [generation, link] of Object.entries(links))
            ensure(
                /^[1-9]\d*$/.test(generation) &&
                    BigInt(generation) <= 0xffffffffffffffffn &&
                    object(link) &&
                    link.version === 1 &&
                    saved.aliases[link.originalGuid] === current &&
                    typeof link.baseHash === 'string' &&
                    /^[a-f0-9]{64}$/.test(link.baseHash) &&
                    typeof link.proposalHash === 'string' &&
                    /^[a-f0-9]{64}$/.test(link.proposalHash),
                'Malformed mutation identity proof',
                ErrorCode.GameConfig,
            )
    }
    return saved
}
// Typed consumers only; this is not permission to rewrite arbitrary IDs.
export function currentPetGuid(state, guid) {
    return petIdentityMigration(state)?.aliases[String(guid)] ?? guid
}
export function mutationProposalProofGuid(state, guid, pending) {
    const saved = petIdentityMigration(state),
        link = saved?.pendingLinks[guid]?.[pending.generation]
    if (link === undefined) {
        ensure(
            !Object.values(saved?.pendingLinks[guid] ?? {}).some((row) => row.baseHash === pending.baseHash),
            'Migrated proposal generation lost its identity proof',
            ErrorCode.GameConfig,
        )
        return guid
    }
    ensure(
        object(link) &&
            link.version === 1 &&
            saved.aliases[link.originalGuid] === guid &&
            link.baseHash === pending.baseHash &&
            pending.petGuid === guid,
        'Mutation identity proof does not match the active proposal',
        ErrorCode.GameConfig,
    )
    return link.originalGuid
}
