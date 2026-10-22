import assert from 'node:assert/strict'

export function assertSyncBefore(protocol, packets, syncName, targetId) {
    const definition = protocol.byName.get(syncName)
    assert(definition, `Unknown synchronization protocol ${syncName}`)
    const target = packets.findIndex((packet) => packet.id === targetId)
    assert(target >= 0, `Missing target packet ${targetId}`)
    const synchronization = packets.slice(0, target).filter((packet) => packet.id === definition.id)
    assert(synchronization.length > 0, `Missing ${syncName} (${definition.id}) before ${targetId}`)
    return synchronization
}
