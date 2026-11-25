import test from 'node:test'
import assert from 'node:assert/strict'
import { protocolHandlerEntry } from '../src/protocol-registration.js'

test('only confirmed retired names are skipped; misspelled handlers still fail', () => {
    const protocol = { byName: new Map(), retiredNames: new Set(['CSProtoRetired']) }
    assert.deepEqual(protocolHandlerEntry(protocol, 'Retired'), { status: 'retired', name: 'CSProtoRetired' })
    assert.throws(() => protocolHandlerEntry(protocol, 'Retierd'), /Unknown handler/)
    assert.throws(() => protocolHandlerEntry({ byName: new Map() }, 'Retired'), /Unknown handler/)
})

test('new names sharing an old numeric ID never receive the retired callback', () => {
    const entry = { id: 44, name: 'CSProtoCurrent', req: 'cs.CurrentRequest' }
    const protocol = { byName: new Map([[entry.name, entry]]), retiredNames: new Set(['CSProtoRetired']) }
    assert.equal(protocolHandlerEntry(protocol, 'Retired').status, 'retired')
    assert.equal(protocolHandlerEntry(protocol, 'Current').entry, entry)
})

test('native-only unknown request bindings stay explicit instead of becoming empty messages', () => {
    const entry = { id: 9141, name: 'CSWorldObjAIHeroInfo' }
    const protocol = { byName: new Map([[entry.name, entry]]), unknownRequests: new Set([9141]) }
    assert.deepEqual(protocolHandlerEntry(protocol, entry.name), {
        status: 'unverified-request',
        name: entry.name,
        id: 9141,
    })
})
