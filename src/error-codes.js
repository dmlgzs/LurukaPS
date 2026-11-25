import codes from '../configs/error-codes.json' with { type: 'json' }

// Generated from the current client ErrCode.lua by azurjs/scripts/export-error-codes.mjs.
// Names preserve the client spelling after removing its ErrCode/Errcode prefix.
// Keep HTTP status, protocol IDs and gameplay enums separate from these codes.
export const ErrorCode = Object.freeze(codes)

// Local payment callback sentinel, not an official client business error.
export const LocalErrorCode = Object.freeze({ OfflinePaymentCallback: -9999 >>> 0 })
