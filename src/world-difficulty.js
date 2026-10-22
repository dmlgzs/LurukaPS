import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeCompleted } from './tasks.js'
import { worldDifficultyCatalogue, selectedWorldDifficulty } from './world-difficulty-catalogue.js'
import { enemyDefinition } from './enemy-state.js'

export function ensureWorldDifficulties(tables, state) {
    const model = worldDifficultyCatalogue(tables)
    const ledger = (state.worldDifficulties ??= {})
    ensure(
        ledger && typeof ledger === 'object' && !Array.isArray(ledger),
        'Malformed map difficulty ledger',
        ErrorCode.GameConfig,
    )
    for (const [mapId, levels] of model.maps) {
        const difficulty = selectedWorldDifficulty(tables, state, mapId)
        const saved = (ledger[mapId] ??= { difficulty, redpoints: [] })
        ensure(
            Array.isArray(saved.redpoints) &&
                new Set(saved.redpoints).size === saved.redpoints.length &&
                saved.redpoints.every((level) => Number.isSafeInteger(level) && levels.has(level)),
            'Malformed map difficulty redpoints',
            ErrorCode.GameConfig,
        )
    }
    if (!state.worldDifficultyLegacyImported) {
        const old = state.flags?.worldDifficultyRedPoints
        if (Array.isArray(old) && old.length === 3 && old[2] === 1 && model.maps.get(old[0])?.has(old[1])) {
            const saved = ledger[old[0]]
            if (!saved.redpoints.includes(old[1])) saved.redpoints.push(old[1])
        }
        state.worldDifficultyLegacyImported = true
    }
    return ledger
}

export function worldDifficultyUnlocked(state, row) {
    if (!row.condition) return true
    ensure(/^\d+(#\d+)*$/.test(row.condition), 'Unsupported map difficulty unlock expression', ErrorCode.FunctionClosed)
    const [kind, ...p] = row.condition.split('#').map(Number)
    ensure(p.every(Number.isSafeInteger), 'Malformed map difficulty unlock parameters', ErrorCode.GameConfig)
    if (kind === 2007 && p.length === 1)
        return (state.taskRecords ?? []).some((task) => task.task_id === p[0] && task.count > 0)
    if (kind === 12045 && p.length === 2) return taskNodeCompleted(state, p[0], p[1])
    if (kind === 2004 && p.length === 1) return state.player.basic_info.lv >= p[0]
    ensure(false, 'Map difficulty unlock condition is not implemented', ErrorCode.FunctionClosed)
}

export function worldDifficultySnapshot(tables, state, selection) {
    const ledger = ensureWorldDifficulties(tables, state)
    return {
        // Available CBT3 Lua clears self.data={} for type0, then dereferences
        // self.data.itemDic without recreating it. Send all map rows at login
        // using the safe merge path as well; no client patch is required.
        send_type: 1,
        infos: (selection ?? [...worldDifficultyCatalogue(tables).maps.keys()]).map((mapId) => ({
            map_id: mapId,
            difficulty: ledger[mapId].difficulty,
            redpoints_info: ledger[mapId].redpoints.map((difficulty) => ({ difficulty, redpoint: true })),
        })),
    }
}

export function switchWorldDifficulty(c, request) {
    const levels = worldDifficultyCatalogue(c.tables).maps.get(request.map_id)
    const row = levels?.get(request.difficulty)
    ensure(row, 'Map difficulty level does not exist', ErrorCode.WorldDifficultyLevelNotExist)
    ensure(!request.redpoints_info?.length, 'Redpoints cannot be changed through difficulty selection')
    const ledger = ensureWorldDifficulties(c.tables, c.state)
    ensure(
        ledger[request.map_id].difficulty !== request.difficulty,
        'Map difficulty is already selected',
        ErrorCode.WorldDifficultyLevelSame,
    )
    ensure(
        worldDifficultyUnlocked(c.state, row),
        'Map difficulty prerequisites are not complete',
        ErrorCode.WorldDifficultyNotEnough,
    )
    const battle =
        c.state.combat?.map_id === request.map_id && c.state.world.map_id === request.map_id ? c.state.combat : null
    const changing = []
    if (battle)
        for (const [id, value] of Object.entries(battle.entities ?? {})) {
            if (!/^\d+$/.test(id) || ![3, 4, 7].includes(Number(BigInt(id) >> 56n))) continue
            const definition = enemyDefinition(c.tables, c.state, id)
            const pack = definition && c.tables.find('enemy_pack', definition.pack_id)
            if (
                !definition ||
                definition.npc_duel ||
                pack?.specialCreateType === 1 ||
                ![1, 4].includes(pack?.levelPolicy)
            )
                continue
            if (value.hp === 0) {
                changing.push({ id, value, dead: true })
                continue
            }
            if (value.hp === undefined) {
                changing.push({ id, value, metadataOnly: true })
                continue
            }
            ensure(
                value.hp > 0 && value.hp <= definition.max_hp,
                'Malformed live enemy HP before difficulty change',
                ErrorCode.GameConfig,
            )
            changing.push({ id, value, oldMax: definition.max_hp })
        }
    ledger[request.map_id].difficulty = request.difficulty
    const infos = []
    for (const entry of changing) {
        const { id, value } = entry
        if (entry.dead) {
            // Do not rewrite historical levels or resurrect dead/captured units.
            infos.push({ uuid: id, hp: 0, alive_state: 1, reason: 0 })
            continue
        }
        const saved = { ...value }
        delete saved.level
        battle.entities[id] = saved
        const next = enemyDefinition(c.tables, c.state, id)
        ensure(next, 'Enemy configuration disappeared during difficulty change', ErrorCode.GameConfig)
        if (entry.metadataOnly) {
            Object.assign(saved, { max_hp: next.max_hp, level: next.level })
            continue // Never spawn or heal a unit from a metadata-only record.
        }
        // Local policy: preserve the remaining HP ratio, rounding upward. The
        // native event rebuilds units, but official HP settlement is unproven.
        const hp = Number((BigInt(value.hp) * BigInt(next.max_hp) + BigInt(entry.oldMax) - 1n) / BigInt(entry.oldMax))
        Object.assign(saved, { hp: Math.min(next.max_hp, Math.max(1, hp)), max_hp: next.max_hp, level: next.level })
        infos.push({ uuid: id, hp: saved.hp, alive_state: saved.alive_state ?? 0, reason: 0 })
    }
    // Lua sets the per-map global parameter and the native enemy change event
    // refreshes units. No invented teleport or whole-wave respawn is sent.
    c.pushBefore('SCProtoWorldDifficultyInfo', worldDifficultySnapshot(c.tables, c.state, [request.map_id]))
    if (infos.length) c.pushBefore('CSProtoObjBattleInfoSync', { infos })
    return {}
}
