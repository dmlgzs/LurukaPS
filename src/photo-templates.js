import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff
const fields = new Set(['val', 'sliderValue', 'v3Val', 'extStrTb'])
function constant(tables, title) {
    const n = Number(tables.get('game').find((row) => row.title === title)?.value)
    ensure(Number.isSafeInteger(n) && n > 0, 'Invalid photo template constant: ' + title, ErrorCode.GameConfig)
    return n
}
function templateId(tables, id) {
    ensure(
        uint(id) && id >= 1001 && !tables.find('photo_template', id),
        'Reserved or invalid custom photo template id',
        ErrorCode.PhotoTempletIdFail,
    )
    return id
}
export function photoTemplateName(tables, name) {
    ensure(
        typeof name === 'string' &&
            name.trim().length > 0 &&
            !/[\u0000-\u001f\u007f]/u.test(name) &&
            Buffer.from(name).toString('utf8') === name,
        'Invalid photo template name',
    )
    ensure([...name].length <= constant(tables, 'PHOTO_FORMWORK_TXT'), 'Photo template name is too long')
    return name
}
export function photoTemplateArguments(value) {
    // The server stores the actual client serialization unchanged, rather than
    // rebuilding parameters from a guessed list of camera/filter defaults.
    ensure(
        typeof value === 'string' && Buffer.byteLength(value) <= 16384 && !/[\u0000-\u001f\u007f]/u.test(value),
        'Invalid photo template arguments',
    )
    if (!value) return value
    for (const entry of value.split('$')) {
        const parts = entry.split('_')
        ensure(
            /^[A-Za-z][A-Za-z0-9]*$/.test(parts.shift()) && parts.length > 0,
            'Invalid photo template parameter group',
        )
        for (const part of parts) {
            ensure(/^\{[^{}]*\}$/.test(part), 'Invalid photo template parameter field')
            const [field, ...values] = part.slice(1, -1).split('|')
            ensure(fields.has(field), 'Unknown photo template parameter field')
            if (field === 'extStrTb') continue
            ensure(
                values.length === (field === 'v3Val' ? 3 : 1) &&
                    values.every((n) => n.trim() && Number.isFinite(Number(n))),
                'Invalid numeric photo template parameter',
            )
        }
    }
    return value
}
function photoUrl(value) {
    ensure(typeof value === 'string', 'Invalid photo template image bytes')
    const bytes = Buffer.from(value, 'base64')
    ensure(bytes.toString('base64') === value && bytes.length <= 1024, 'Invalid photo template image bytes')
    // URL is a protobuf bytes field. Keep its base64 representation intact.
    // The current client supplies an object basename, not an HTTP URL.
    return value
}
function records(state) {
    const value = state.photoTemplates ?? {}
    ensure(
        value && typeof value === 'object' && !Array.isArray(value),
        'Invalid stored photo templates',
        ErrorCode.GameConfig,
    )
    for (const [key, row] of Object.entries(value)) {
        ensure(
            row &&
                uint(row.id) &&
                row.id >= 1001 &&
                String(row.id) === key &&
                typeof row.name === 'string' &&
                typeof row.arg === 'string' &&
                typeof row.url === 'string',
            'Invalid stored photo template',
            ErrorCode.GameConfig,
        )
    }
    return value
}
export function photoTemplateSnapshot(state) {
    return {
        infos: Object.values(records(state))
            .sort((a, b) => a.id - b.id)
            .map(({ id, name, url, arg }) => ({ id, name, url, arg })),
        dels: [],
    }
}
export function savePhotoTemplate(c, r) {
    const id = templateId(c.tables, r.id),
        rows = records(c.state),
        max = constant(c.tables, 'PHOTO_FORMWORK_MAX')
    ensure(
        rows[id] || Object.keys(rows).length < max,
        'Custom photo template capacity reached',
        ErrorCode.PhotoTempletNumIsMax,
    )
    const row = {
        id,
        name: photoTemplateName(c.tables, r.name),
        url: photoUrl(r.url ?? ''),
        arg: photoTemplateArguments(r.arg ?? ''),
    }
    c.state.photoTemplates = { ...rows, [id]: row }
    c.pushBefore('CSProtoPhotoGraphTempletSync', { infos: [row], dels: [] })
    return {}
}

export function renamePhotoTemplate(c, r) {
    const id = templateId(c.tables, r.id),
        rows = records(c.state)
    ensure(rows[id], 'Custom photo template does not exist', ErrorCode.PhotoTempletNotExist)
    ensure(typeof r.name === 'string', 'Missing photo template name bytes')
    let name
    try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(r.name, 'base64'))
    } catch {
        ensure(false, 'Photo template name is not valid UTF-8')
    }
    const row = { ...rows[id], name: photoTemplateName(c.tables, name) }
    c.state.photoTemplates = { ...rows, [id]: row }
    c.pushBefore('CSProtoPhotoGraphTempletSync', { infos: [row], dels: [] })
    return {}
}

export function deletePhotoTemplate(c, r) {
    const id = templateId(c.tables, r.u32),
        rows = records(c.state)
    ensure(rows[id], 'Custom photo template does not exist', ErrorCode.PhotoTempletNotExist)
    const next = { ...rows }
    delete next[id]
    c.state.photoTemplates = next
    // Current UI optimistically removes this record before sending 9807.
    // The wire defines dels, while the inspected Lua receiver only merges infos.
    c.pushBefore('CSProtoPhotoGraphTempletSync', { infos: [], dels: [id] })
    return {}
}
