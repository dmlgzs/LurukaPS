import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import path from 'node:path'
import { ensure } from './handlers/common.js'
export class WorldObjectCatalog {
    constructor(tables, directory = undefined) {
        this.tables = tables
        this.directory = directory
        this.cache = new Map()
        this.indexes = new Map()
    }
    get(name) {
        if (!this.cache.has(name)) {
            const file = this.directory === undefined ? undefined : path.join(this.directory, name + '.json')
            this.cache.set(
                name,
                file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : this.tables.get(name),
            )
        }
        return this.cache.get(name)
    }
    find(name, id) {
        if (!this.indexes.has(name)) this.indexes.set(name, new Map(this.get(name).map((r) => [r.id, r])))
        return this.indexes.get(name).get(id)
    }
    object(map, id) {
        ensure(Number.isInteger(map) && map > 0 && Number.isInteger(id) && id > 0, 'Invalid world object')
        const row = this.find('worldmap_' + map, id)
        ensure(row && row.cityId === map, 'Object is not in current map')
        const spawner = this.find('world_spawner', row.spawnerId)
        ensure(spawner, 'World spawner missing', ErrorCode.SpawnerConfIsNull)
        const position = String(row.position).split('|').map(Number)
        ensure(
            position.length === 3 && position.every(Number.isFinite),
            'World object position missing',
            ErrorCode.GameConfig,
        )
        return {
            row,
            spawner,
            pos: {
                x: Math.round(position[0] * 100),
                y: Math.round(position[1] * 100),
                z: Math.round(position[2] * 100),
            },
        }
    }
    drops(id, randomInt, budget = { count: 0 }, stack = []) {
        ensure(stack.length < 16 && !stack.includes(id), 'Recursive world drop configuration', ErrorCode.GameConfig)
        const rows = this.get('drop').filter((r) => r.dropId === id)
        ensure(rows.length, 'Unknown world drop', ErrorCode.GameConfig)
        const groups = new Map()
        for (const row of rows) {
            ensure(
                !row.tacticsGroup && !row.tacticsWeight && !row.tacticsValue && !row.allowanceValue,
                'World drop tactics are not implemented',
                ErrorCode.FunctionClosed,
            )
            if (!groups.has(row.dropGroupId)) groups.set(row.dropGroupId, [])
            groups.get(row.dropGroupId).push(row)
        }
        const rewards = []
        for (const choices of groups.values()) {
            const total = choices.reduce((n, r) => n + r.weight, 0)
            ensure(
                choices.every((r) => Number.isSafeInteger(r.weight) && r.weight >= 0) && Number.isSafeInteger(total),
                'Invalid drop weight',
                ErrorCode.GameConfig,
            )
            if (!total) {
                ensure(
                    choices.every((r) => r.type === 0),
                    'Empty world drop pool',
                    ErrorCode.GameConfig,
                )
                continue
            }
            let draw = randomInt(total),
                selected
            for (const row of choices) {
                draw -= row.weight
                if (draw < 0) {
                    selected = row
                    break
                }
            }
            if (selected.type === 0) continue
            ensure(
                Number.isSafeInteger(selected.minValue) &&
                    Number.isSafeInteger(selected.maxValue) &&
                    selected.minValue >= 0 &&
                    selected.maxValue >= selected.minValue,
                'Invalid drop quantity',
                ErrorCode.GameConfig,
            )
            const count = selected.minValue + randomInt(selected.maxValue - selected.minValue + 1)
            if (!count) continue
            if (selected.type === 27) {
                ensure(count <= 512, 'Drop roll limit', ErrorCode.GameConfig)
                for (let i = 0; i < count; i++)
                    rewards.push(...this.drops(selected.itemId, randomInt, budget, [...stack, id]))
            } else {
                ensure(++budget.count <= 4096, 'Drop result limit', ErrorCode.GameConfig)
                rewards.push({ itemtype: selected.type, itemid: selected.itemId, itemnum: count })
            }
        }
        const merged = new Map()
        for (const r of rewards) {
            const key = `${r.itemtype}:${r.itemid}`,
                old = merged.get(key)
            if (old) old.itemnum += r.itemnum
            else merged.set(key, { ...r })
        }
        return [...merged.values()]
    }
}
