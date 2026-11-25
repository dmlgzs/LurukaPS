// Missing retired names are deliberate version changes. Unknown names remain
// fatal so a typo or incomplete extraction cannot silently disable a handler.
export function protocolHandlerEntry(protocol, name) {
    const entry = protocol.byName.get(name) || protocol.byName.get(`CSProto${name}`)
    if (!entry) {
        const retired = [name, `CSProto${name}`].find((value) => protocol.retiredNames?.has(value))
        if (retired) return { status: 'retired', name: retired }
        throw Error(`Unknown handler ${name}`)
    }
    if (protocol.unknownRequests?.has(entry.id)) return { status: 'unverified-request', name: entry.name, id: entry.id }
    return { status: 'active', name: entry.name, id: entry.id, entry }
}
