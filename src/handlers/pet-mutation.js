import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { mutationPolicy } from '../pet-mutation-policy.js'
import { generateMutation } from '../pet-mutation.js'

// Not registered by the current service. Explicit private fixtures exercise the
// actual protocol/Store path while client lifecycle release gates stay open.
export function registerPetMutations(on, tables, { privateEnabled = false } = {}) {
    if (!privateEnabled) return false
    ensure(mutationPolicy().userApproved === true, 'Mutation local rules are not approved', ErrorCode.FunctionClosed)
    on('UseMutationTimes', (c, r) => {
        generateMutation(tables, c.state, String(r.pet_guid ?? '0'), c.randomInt, c.now)
        return {}
    })
    return true
}
