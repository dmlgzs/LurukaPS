import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

function integer(value) {
    ensure(
        typeof value === 'bigint' ||
            (typeof value === 'number' && Number.isSafeInteger(value)) ||
            (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)),
        'Malformed production work integer',
        ErrorCode.GameConfig,
    )
    return BigInt(value)
}
function gcd(a, b) {
    a = a < 0n ? -a : a
    while (b) [a, b] = [b, a % b]
    return a
}
// Only serialized string pairs enter persisted state. Arithmetic values stay
// local; neither wire uints nor JSON can represent arbitrary BigInt fractions.
export function workFraction(value, denominator) {
    let n, d
    if (denominator !== undefined) {
        n = integer(value)
        d = integer(denominator)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        ensure(
            Object.keys(value).length === 2 && Object.hasOwn(value, 'n') && Object.hasOwn(value, 'd'),
            'Malformed production work fraction',
            ErrorCode.GameConfig,
        )
        n = integer(value.n)
        d = integer(value.d)
    } else {
        n = integer(value)
        d = 1n
    }
    ensure(d > 0n, 'Invalid production work denominator', ErrorCode.GameConfig)
    const divisor = gcd(n, d)
    return { n: n / divisor, d: d / divisor }
}
export function workAdd(left, right) {
    const a = workFraction(left),
        b = workFraction(right)
    return workFraction(a.n * b.d + b.n * a.d, a.d * b.d)
}
export function workSub(left, right) {
    const a = workFraction(left),
        b = workFraction(right)
    return workFraction(a.n * b.d - b.n * a.d, a.d * b.d)
}
export function workMul(left, right) {
    const a = workFraction(left),
        b = workFraction(right)
    return workFraction(a.n * b.n, a.d * b.d)
}
export function workDiv(left, right) {
    const a = workFraction(left),
        b = workFraction(right)
    ensure(b.n !== 0n, 'Production work division by zero', ErrorCode.GameConfig)
    return b.n < 0n ? workFraction(-a.n * b.d, -a.d * b.n) : workFraction(a.n * b.d, a.d * b.n)
}
export function workCompare(left, right) {
    const a = workFraction(left),
        b = workFraction(right),
        delta = a.n * b.d - b.n * a.d
    return delta < 0n ? -1 : delta > 0n ? 1 : 0
}
export function workFloor(value) {
    const { n, d } = workFraction(value)
    return n >= 0n ? n / d : -((-n + d - 1n) / d)
}
export function workCeil(value) {
    const { n, d } = workFraction(value)
    return -workFloor({ n: -n, d })
}
export function workSerialize(value) {
    const { n, d } = workFraction(value)
    return { n: String(n), d: String(d) }
}
export function workNumber(value) {
    const { n, d } = workFraction(value)
    ensure(
        d === 1n && n >= -BigInt(Number.MAX_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER),
        'Production work value is not an exact safe integer',
        ErrorCode.GameConfig,
    )
    return Number(n)
}
