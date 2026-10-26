import policy from '../../configs/newerflag-compat-policy.json' with { type: 'json' }
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'

ensure(
    policy.version === 1 &&
        policy.mode === 'local-download-start-compatibility' &&
        policy.officiallyVerified === false &&
        policy.protocol === 6146 &&
        policy.fullProtocolStatus === 'partial' &&
        policy.request === 'cs.CSUint32' &&
        JSON.stringify(policy.acceptedU32) === '[0]' &&
        policy.omittedMeansGetterDefault === true &&
        policy.senderIdentity === 'not-carried-on-wire-shape-only' &&
        policy.authentication === 'existing-session-id-login-guard' &&
        policy.requiresEnteredGame === false &&
        policy.nonzero === 'reject-FunctionClosed-and-diagnose' &&
        policy.persistence === 'none' &&
        policy.stateMutation === 'none' &&
        policy.completion === 'independent-9904-2519',
    'Invalid local download-start compatibility policy',
    ErrorCode.GameConfig,
)

export function registerDownloadStartCompatibility(on) {
    on('SetNewerFlag', (context, request) => {
        const value = request.u32 ?? 0
        ensure(
            Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
            'Invalid download-start notification value',
            ErrorCode.InvalidArgument,
        )
        if (value !== 0) {
            try {
                console.warn(
                    '[newerflag-compat]',
                    JSON.stringify({
                        protocol: 6146,
                        accountId: context.id,
                        u32: value,
                        reason: 'nonzero-official-flag-semantics-unresolved',
                        action: 'FunctionClosed',
                    }),
                )
            } catch {
                // Diagnostics must not replace the defined rejection code.
            }
            ensure(false, 'Nonzero newer flag is not implemented', ErrorCode.FunctionClosed)
        }
        // No state is passed to this handler. This is only the selected local
        // download-start compatibility, not an official flag or task receipt.
        return {}
    })
}
