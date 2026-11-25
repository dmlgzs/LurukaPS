import fs from 'node:fs'
import path from 'node:path'
import { configuration } from './config.js'

const caches = new Map()
const manifests = new WeakMap()

// A complete export distinguishes definitions not shipped in this version
// from a declared table whose file is missing or corrupt. Never infer this
// distinction from an ENOENT catch or replace a missing table with [].
export function tableExportManifest(tables) {
    if (!tables?.dir) return undefined
    if (manifests.has(tables)) return manifests.get(tables)
    const directory = path.resolve(tables.dir)
    for (const file of [path.join(directory, 'tables_index.json'), path.join(directory, '../tables_index.json')]) {
        if (!fs.existsSync(file)) continue
        const index = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (index.complete !== true || !Array.isArray(index.tables) || !index.tables.length)
            throw Error('Incomplete table export manifest')
        const rows = index.tables.filter((row) => !row.section || row.section === 'core')
        if (
            !rows.length ||
            rows.some(
                (row) =>
                    typeof row.name !== 'string' ||
                    !/^[a-zA-Z0-9_]+$/.test(row.name) ||
                    typeof row.file !== 'string' ||
                    path.basename(row.file) !== `${row.name}.json` ||
                    path.isAbsolute(row.file),
            )
        )
            throw Error('Invalid table export manifest')
        if (
            (index.coreTables !== undefined && index.coreTables !== rows.length) ||
            (index.totalTables !== undefined && index.totalTables !== index.tables.length)
        )
            throw Error('Incomplete table export manifest counts')
        if (!rows.every((row) => path.dirname(path.resolve(path.dirname(file), row.file)) === directory)) continue
        const names = new Set(rows.map((row) => row.name))
        if (names.size !== rows.length) throw Error('Duplicate table export definitions')
        const result = { names, packageVersions: index.packageVersions, file }
        manifests.set(tables, result)
        return result
    }
    return undefined
}

// One versioned source for runtime and import-time consumers. No CBT3 fallback.
export function readTable(name, directory = configuration().tables) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(name)) throw Error('Invalid table name')
    const root = path.resolve(directory)
    let cache = caches.get(root)
    if (!cache) caches.set(root, (cache = new Map()))
    if (!cache.has(name)) {
        const rows = JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'))
        if (!Array.isArray(rows)) throw Error(`Invalid table ${name}`)
        cache.set(name, rows)
    }
    return cache.get(name)
}
