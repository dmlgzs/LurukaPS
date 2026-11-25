import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import protobuf from 'protobufjs'
import { protocolSchemaShape, protocolSchemaOptions } from './protocol-schema.js'
const sourceTextBytes = (bytes, source) =>
    source?.textFingerprint === 'utf8-lf' ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes
export class Protocol {
    constructor(base) {
        const protocolBytes = fs.readFileSync(path.join(base, 'configs/protocol.json'))
        this.entries = JSON.parse(protocolBytes)
        if (!Array.isArray(this.entries)) throw Error('Invalid protocol entries')
        const sourceFile = path.join(base, 'configs/protocol-source.json')
        this.source = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile)) : undefined
        this.clientVersion = this.source?.active ? this.source.clientVersion : undefined
        this.retiredNames = new Set(this.source?.active ? this.source.retiredNames : [])
        this.unknownRequests = new Set(
            this.entries.filter((entry) => entry.reqUnknown === true).map((entry) => entry.id),
        )
        this.byId = new Map(this.entries.map((e) => [e.id, e]))
        this.byName = new Map(this.entries.map((e) => [e.name, e]))
        if (this.byId.size !== this.entries.length || this.byName.size !== this.entries.length)
            throw Error('Duplicate protocol ID or name')
        for (const entry of this.entries) {
            if (
                !Number.isSafeInteger(entry.id) ||
                entry.id < 0 ||
                entry.id > 65535 ||
                typeof entry.name !== 'string' ||
                !entry.name ||
                (entry.reqUnknown !== undefined && entry.reqUnknown !== true) ||
                (entry.reqUnknown && Object.hasOwn(entry, 'req')) ||
                ['req', 'rsp'].some((side) => Object.hasOwn(entry, side) && typeof entry[side] !== 'string')
            )
                throw Error(`Invalid protocol entry ${entry.name ?? entry.id}`)
        }
        if (this.source) {
            const source = this.source
            if (
                source.schemaVersion !== 1 ||
                source.active !== true ||
                (source.textFingerprint !== undefined && source.textFingerprint !== 'utf8-lf') ||
                typeof source.clientVersion !== 'string' ||
                !source.clientVersion ||
                source.protocolEntries !== this.entries.length ||
                source.protocolSha256 !==
                    crypto.createHash('sha256').update(sourceTextBytes(protocolBytes, source)).digest('hex') ||
                !Array.isArray(source.retiredNames) ||
                source.retiredNames.some((name) => typeof name !== 'string' || !name || this.byName.has(name)) ||
                this.retiredNames.size !== source.retiredNames.length ||
                !Array.isArray(source.unknownRequestIds) ||
                new Set(source.unknownRequestIds).size !== source.unknownRequestIds.length ||
                source.unknownRequestIds.length !== this.unknownRequests.size ||
                source.unknownRequestIds.some((id) => !this.unknownRequests.has(id)) ||
                JSON.stringify(source.unknownRequestNames) !==
                    JSON.stringify(this.entries.filter((entry) => entry.reqUnknown).map((entry) => entry.name))
            )
                throw Error('Invalid active protocol source metadata')
        }
        const dir = path.join(base, 'proto/lua/proto')
        if (this.source?.idlFiles !== undefined) {
            const files = this.source.idlFiles
            const actualNames = fs
                .readdirSync(dir)
                .filter((name) => name.endsWith('.proto'))
                .sort()
            if (
                !Array.isArray(files) ||
                files.some((file) => typeof file.name !== 'string' || !/^[A-Za-z0-9_]+\.proto$/.test(file.name)) ||
                JSON.stringify(files.map((file) => file.name).sort()) !== JSON.stringify(actualNames)
            )
                throw Error('Invalid active protocol IDL manifest')
            for (const file of files) {
                const bytes = sourceTextBytes(fs.readFileSync(path.join(dir, file.name)), this.source)
                if (
                    file.bytes !== bytes.length ||
                    file.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')
                )
                    throw Error(`Active protocol IDL fingerprint mismatch ${file.name}`)
            }
        }
        this.root = new protobuf.Root()
        this.root.resolvePath = (_, target) => path.join(dir, path.basename(target))
        const merged = { nested: {} }
        const merge = (target, source, prefix = '') => {
            for (const [name, value] of Object.entries(source)) {
                if (!target[name]) target[name] = value
                else if (value.nested && !value.fields && !value.values)
                    merge(target[name].nested, value.nested, `${prefix}.${name}`)
                else if (JSON.stringify(target[name]) !== JSON.stringify(value))
                    throw Error(`Conflicting protobuf definition ${prefix}.${name}`)
            }
        }
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.proto'))) {
            const parsed = protobuf.parse(fs.readFileSync(path.join(dir, f), 'utf8'), { keepCase: true }).root.toJSON()
            merge(merged.nested, parsed.nested)
        }
        this.root = protobuf.Root.fromJSON(merged)
        this.root.resolveAll()
        for (const [key, schema] of [
            ['schemaSha256', protocolSchemaShape],
            ['schemaOptionsSha256', protocolSchemaOptions],
        ]) {
            if (
                this.source?.[key] !== undefined &&
                this.source[key] !==
                    crypto
                        .createHash('sha256')
                        .update(JSON.stringify(schema(this.root)))
                        .digest('hex')
            )
                throw Error(`Active protocol schema fingerprint mismatch ${key}`)
        }
        this.missing = []
        for (const e of this.entries)
            for (const side of ['req', 'rsp']) {
                if (e[side]) {
                    try {
                        this.root.lookupType(e[side])
                    } catch {
                        this.missing.push({ id: e.id, side, type: e[side] })
                    }
                }
            }
        if (this.source && this.missing.length) throw Error('Active protocol has missing message definitions')
    }
    type(name) {
        return this.root.lookupType(name.includes('.') ? name : `cs.${name}`)
    }
    encode(name, value) {
        if (!name) return Buffer.alloc(0)
        const type = this.type(name)
        // Reject silently discarded field names, including nested objects.
        this.checkFields(type, value)
        const msg = type.fromObject(value)
        const error = type.verify(msg)
        if (error) throw Error(`${name}: ${error}`)
        return Buffer.from(type.encode(msg).finish())
    }
    checkFields(type, value) {
        for (const [key, v] of Object.entries(value)) {
            const f = type.fields[key]
            if (!f) throw Error(`Unknown field ${type.fullName}.${key}`)
            if (f.resolvedType instanceof protobuf.Type && v != null) {
                for (const item of f.repeated ? v : f.map ? Object.values(v) : [v])
                    this.checkFields(f.resolvedType, item)
            }
        }
    }
    decode(name, bytes) {
        if (!name) {
            if (bytes.length) throw Error('Unexpected request payload')
            return {}
        }
        const type = this.type(name)
        return type.toObject(type.decode(bytes), {
            longs: String,
            bytes: String,
            defaults: false,
            arrays: true,
            objects: true,
        })
    }
}
