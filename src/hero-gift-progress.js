import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/hero-gift-progress-policy.json' with { type: 'json' }

const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
function configuration() {
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.countUnit === 'successfully-consumed-items' &&
            policy.historyPolicy === 'new-successful-6610-only' &&
            JSON.stringify(policy.includedCommonItemTypes) === '[110,111]' &&
            policy.receiptLimit === 256,
        'Invalid hero gift progress policy',
        ErrorCode.GameConfig,
    )
}
export function heroGiftProgressFacts(state) {
    const ledger = state.heroGiftProgress
    if (ledger === undefined) return { total: 0, requests: 0, normal: 0, furniture: 0, revision: 0 }
    ensure(
        object(ledger) &&
            ledger.version === 1 &&
            [ledger.total, ledger.requests, ledger.normal, ledger.furniture, ledger.revision].every(uint) &&
            ledger.total === ledger.normal + ledger.furniture &&
            ledger.requests <= ledger.total &&
            ledger.revision === ledger.requests,
        'Invalid saved hero gift progress',
        ErrorCode.GameConfig,
    )
    return {
        total: ledger.total,
        requests: ledger.requests,
        normal: ledger.normal,
        furniture: ledger.furniture,
        revision: ledger.revision,
    }
}
function requestShape(r) {
    return [r.heroId, r.item_id, r.item_type, r.num].join(':')
}
function receiptBook(state) {
    const ledger = state.heroGiftProgress
    ensure(
        object(ledger.receipts) &&
            Array.isArray(ledger.receiptKeys) &&
            ledger.receiptKeys.length <= policy.receiptLimit &&
            ledger.receiptKeys.every((key) => typeof key === 'string' && key.length > 0) &&
            new Set(ledger.receiptKeys).size === ledger.receiptKeys.length &&
            Object.keys(ledger.receipts).length === ledger.receiptKeys.length &&
            ledger.receiptKeys.every((key) => Object.hasOwn(ledger.receipts, key)),
        'Invalid saved hero gift request receipts',
        ErrorCode.GameConfig,
    )
    return ledger
}
export function replayHeroGiftRequest(c, r) {
    configuration()
    heroGiftProgressFacts(c.state)
    if (!c.state.heroGiftProgress || !c.requestKey) return null
    const old = receiptBook(c.state).receipts[c.requestKey]
    if (!old) return null
    ensure(object(old) && old.shape === requestShape(r), 'Hero gift retry payload changed', ErrorCode.HeroGiftArgs)
    ensure(
        object(old.response) &&
            old.response.item_id === r.item_id &&
            old.response.hero_id === r.heroId &&
            old.response.item_type === r.item_type &&
            old.response.num === r.num,
        'Invalid saved hero gift response',
        ErrorCode.GameConfig,
    )
    return { ...old.response }
}
// Only the successful6610 handler calls this after recipient/category/quantity,
// inventory and favor mutations. All facts share the existing transaction.
export function recordHeroGiftProgress(c, r, response) {
    configuration()
    const facts = heroGiftProgressFacts(c.state)
    ensure(
        [r.heroId, r.item_id, r.num].every((n) => uint(n) && n > 0) &&
            policy.includedCommonItemTypes.includes(r.item_type),
        'Invalid hero gift progress event',
        ErrorCode.GameConfig,
    )
    const ledger = (c.state.heroGiftProgress ??= { version: 1, ...facts, receipts: {}, receiptKeys: [] })
    receiptBook(c.state)
    ensure(
        !c.requestKey || !Object.hasOwn(ledger.receipts, c.requestKey),
        'Hero gift request already recorded',
        ErrorCode.InvalidLogic,
    )
    const total = facts.total + r.num,
        requests = facts.requests + 1,
        normal = facts.normal + (r.item_type === 110 ? r.num : 0),
        furniture = facts.furniture + (r.item_type === 111 ? r.num : 0)
    ensure([total, requests, normal, furniture].every(uint), 'Hero gift progress overflow', ErrorCode.GameConfig)
    Object.assign(ledger, { total, requests, normal, furniture, revision: requests })
    if (c.requestKey) {
        ledger.receipts[c.requestKey] = { shape: requestShape(r), response: { ...response } }
        ledger.receiptKeys.push(c.requestKey)
        while (ledger.receiptKeys.length > policy.receiptLimit) delete ledger.receipts[ledger.receiptKeys.shift()]
    }
}
export function heroGiftProgressRule(tokens) {
    return (
        tokens.length === 2 &&
        uint(tokens[1]) &&
        ((tokens[0] === 12227 && tokens[1] === 1) || (tokens[0] === 12228 && tokens[1] > 0))
    )
}
export function heroGiftProgressValue(state, tokens) {
    if (!heroGiftProgressRule(tokens)) return null
    const facts = heroGiftProgressFacts(state)
    return tokens[0] === 12227 ? Number(facts.total > 0) : facts.total
}
