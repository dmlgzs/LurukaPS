import test from 'node:test'
import assert from 'node:assert/strict'
import {
    workFraction,
    workAdd,
    workSub,
    workMul,
    workDiv,
    workCompare,
    workFloor,
    workCeil,
    workSerialize,
    workNumber,
} from '../src/production-work-fractions.js'
import { ErrorCode } from '../src/error-codes.js'

test('assisted-work installments retain exact energy across arbitrary observation boundaries and JSON restart', () => {
    let total = workFraction(0)
    for (const seconds of [1, 1, 7, 13, 27]) total = workAdd(total, workDiv(workMul(20, seconds), 49))
    assert.equal(workNumber(total), 20)
    const half = workSerialize(workDiv(20, 3))
    assert.deepEqual(workFraction(JSON.parse(JSON.stringify(half))), { n: 20n, d: 3n })
    assert.equal(workCompare(workAdd(half, half), workSub(20, half)), 0)
    assert.equal(workFloor(workSub(11, workDiv(1, 3))), 10n)
    assert.equal(workCompare(workSub(11, workDiv(1, 3)), 10), 1)
})

test('fractions reject corrupted numbers and unsafe projection instead of rounding a fee or serializing BigInt', () => {
    for (const value of [
        NaN,
        Infinity,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        { n: '1', d: '0' },
        { n: '1', d: '-2' },
        { n: '1.5', d: '2' },
    ])
        assert.throws(
            () => workFraction(value),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => workNumber(workDiv(1, 2)),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => workDiv(1, 0),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.equal(workFloor(workDiv(-1, 3)), -1n)
    assert.equal(workCeil(workDiv(-1, 3)), 0n)
    assert.equal(workNumber(workDiv(6, -3)), -2)
})
