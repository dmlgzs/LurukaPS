import protobuf from 'protobufjs'

export function protocolSchemaShape(root) {
    root.resolveAll()
    const shape = {}
    function visit(ns) {
        for (const item of ns.nestedArray ?? []) {
            const name = item.fullName.slice(1)
            if (item instanceof protobuf.Type)
                shape[name] = {
                    kind: 'message',
                    fields: item.fieldsArray
                        .map((field) => ({
                            id: field.id,
                            name: field.name,
                            type: field.resolvedType?.fullName.slice(1) ?? field.type,
                            rule: field.rule ?? 'optional',
                            map: !!field.map,
                            keyType: field.keyType ?? null,
                            oneof: field.partOf?.name ?? null,
                            packed: field.packed,
                            default: field.options?.default ?? null,
                            jsonName: field.options?.json_name ?? null,
                        }))
                        .sort((a, b) => a.id - b.id),
                }
            else if (item instanceof protobuf.Enum)
                shape[name] = {
                    kind: 'enum',
                    values: Object.fromEntries(Object.entries(item.values).sort(([a], [b]) => a.localeCompare(b))),
                }
            visit(item)
        }
    }
    visit(root)
    return Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b)))
}

// Include options in a separate fingerprint because descriptor bootstrap APIs
// do not preserve custom options; source-side verification checks them directly.
export function protocolSchemaOptions(root) {
    root.resolveAll()
    const result = {}
    const ordered = (value) => {
        if (Array.isArray(value)) return value.map(ordered)
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, item]) => [key, ordered(item)]),
            )
        return value
    }
    const options = (name, object) => {
        if (object.options && Object.keys(object.options).length) result[name] = ordered(object.options)
    }
    function visit(namespace) {
        for (const item of namespace.nestedArray ?? []) {
            options(item.fullName.slice(1), item)
            if (item instanceof protobuf.Type)
                for (const field of item.fieldsArray) options(`${item.fullName.slice(1)}#${field.id}`, field)
            visit(item)
        }
    }
    visit(root)
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
