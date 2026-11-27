import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { protocolCoverageStatus, protocolCoverageStatuses } from '../scripts/protocol-coverage-status.js'

const entries = JSON.parse(fs.readFileSync(new URL('../configs/protocol.json', import.meta.url), 'utf8'))
const source = JSON.parse(fs.readFileSync(new URL('../configs/protocol-source.json', import.meta.url), 'utf8'))
const entry = (id) => {
    const result = entries.find((item) => item.id === id)
    assert(result, `current protocol${id} must exist`)
    return result
}
const empty = new Set()

test('current10760 retains explicit body uncertainty even if a registration were added, rather than appearing push-only or implemented', () => {
    assert.equal(source.clientVersion, '1.0.0')
    assert.deepEqual(source.unknownRequestIds, [10760])
    assert.equal(entry(10760).reqUnknown, true)
    assert.equal(entry(10760).req, undefined)
    assert.equal(protocolCoverageStatus(entry(10760), empty, empty), 'request-schema-unknown')
    assert.equal(protocolCoverageStatus(entry(10760), new Set([10760]), empty), 'request-schema-unknown')
})

test('an evidenced empty request body differs from an absent request schema regardless of protocol name prefix', () => {
    assert.equal(entry(9529).req, '')
    assert.equal(protocolCoverageStatus(entry(9529), empty, empty), 'request-schema-unregistered')
    assert.equal(entry(11055).name, 'CSProtoSceneModeChange')
    assert.equal(entry(11055).req, undefined)
    assert.equal(protocolCoverageStatus(entry(11055), empty, empty), 'no-request-schema')
    assert.equal(protocolCoverageStatus(entry(9593), empty, empty), 'no-request-schema')
})

test('a local handler, a declared transport core and a known but unregistered request are separate evidence categories', () => {
    assert.equal(protocolCoverageStatus(entry(1001), empty, new Set([1001])), 'transport-core-declared')
    assert.equal(protocolCoverageStatus(entry(1001), new Set([1001]), new Set([1001])), 'registered-local')
    assert.equal(protocolCoverageStatus(entry(11820), empty, empty), 'request-schema-unregistered')
    assert(!protocolCoverageStatuses.includes('implemented-local'))
    assert(!protocolCoverageStatuses.includes('push-only'))
})

test('every current entry has exactly one supported category without rewriting the active protocol source', () => {
    const unknown = entries.filter((item) => protocolCoverageStatus(item, empty, empty) === 'request-schema-unknown')
    assert.deepEqual(
        unknown.map((item) => item.id),
        source.unknownRequestIds,
    )
    for (const item of entries) assert(protocolCoverageStatuses.includes(protocolCoverageStatus(item, empty, empty)))
    assert.equal(entries.length, source.protocolEntries)
})
