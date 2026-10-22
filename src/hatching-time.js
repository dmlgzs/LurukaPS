import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const catalogs = new WeakMap()
const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
function catalog(tables) {
    if (!catalogs.has(tables))
        catalogs.set(tables, {
            constants: new Map(tables.get('game').map((r) => [r.title, Number(r.value)])),
            talents: new Map(tables.get('home_talent').map((r) => [r.talentId, r])),
            technology: tables.get('home_technology'),
        })
    return catalogs.get(tables)
}
function value(tables, rows, id, element) {
    const config = tables.find('home_buff', id)
    ensure(config && [1, 2].includes(config.type), 'Missing hatch time buff configuration', ErrorCode.GameConfig)
    // Current 4001 and 4002 both use ADD (3). Do not guess a future merge rule.
    ensure(config.algorithmType === 3, 'Hatch time buff merge requires support', ErrorCode.FunctionClosed)
    let result = 0
    for (const row of rows) {
        const ids = list(row.buffId)
        if (!ids.includes(id)) continue
        const conditions = String(row.buffCondition ?? '')
            .split('|')
            .filter(Boolean)
            .map((term) => term.split('#').map(Number))
        ensure(
            conditions.every((term) => term.length === 2 && term.every(Number.isSafeInteger)),
            'Invalid hatch buff condition',
            ErrorCode.GameConfig,
        )
        const matches = ([key, wanted]) => key === 2023 && wanted === element
        if (!(row.buffConditionLogic === 2 ? conditions.some(matches) : conditions.every(matches))) continue
        const params = String(row.buffParams ?? '').split('|')
        for (let i = 0; i < ids.length; i++)
            if (ids[i] === id) {
                const raw = Number(params[i])
                ensure(Number.isFinite(raw) && raw >= 0, 'Invalid hatch time buff value', ErrorCode.GameConfig)
                result += config.type === 2 ? raw / 10000 : raw
            }
    }
    return result
}
// Lua PetStore.getEggIncubationTime -> getQualityTimeReduct(buildType=12).
// The similarly named GetPetEggHatchTimeReduct is NOT this consumer's helper.
export function hatchSeconds(tables, state, build, eggConfig) {
    ensure(
        eggConfig && Number.isSafeInteger(eggConfig.eggTime) && eggConfig.eggTime > 0,
        'Invalid incubation duration',
        ErrorCode.GameConfig,
    )
    const station = tables.find('home_building_production', build.build_id)
    ensure(station, 'Missing hatch station configuration', ErrorCode.BuildProductConfNotFound)
    const data = catalog(tables),
        guid = String(build.station_pet_guid ?? '0')
    const worker = guid === '0' ? undefined : state.pets?.find((p) => p.guid === guid)
    ensure(guid === '0' || worker, 'Hatch worker is not owned', ErrorCode.PetNotExist)
    ensure(
        !worker || worker.work_build === build.guid,
        'Hatch worker does not belong to this station',
        ErrorCode.PetNotMatchBuild,
    )
    const rows = (worker?.talent_id ?? []).map((id) => {
        const row = data.talents.get(id)
        ensure(row, 'Missing hatch worker talent configuration', ErrorCode.GameConfig)
        return row
    })
    for (const row of data.technology)
        if (state.home?.technology?.levels?.[row.type]?.level === row.level) rows.push(row)
    const fixed = value(tables, rows, 4001, eggConfig.element)
    let reduction = value(tables, rows, 4002, eggConfig.element)
    if (worker) {
        const types = list(station.laborType)
        const labor = worker.labor_infos?.filter((r) => types.includes(r.labor_id) && r.labor_grade > 0).at(-1)
        ensure(labor, 'Pet lacks required hatch ability', ErrorCode.PetLaborNotMatch)
        const efficiency = tables.find('home_labor_efficiency', labor.labor_grade)
        ensure(
            efficiency && Number.isFinite(efficiency.EggTimeReduct),
            'Missing hatch labor grade',
            ErrorCode.GameConfig,
        )
        let laborReduction = Math.max(0, efficiency.EggTimeReduct) / 10000
        if (worker.satiety_val <= data.constants.get('PET_HOME_TIRED_SATIETY'))
            laborReduction *= data.constants.get('HOME_LABOR_EGG_DECREASE') / 10000
        reduction += laborReduction
    }
    const minimum = data.constants.get('HOME_HATCH_BOTTOM_TIME')
    ensure(Number.isSafeInteger(minimum) && minimum > 0, 'Invalid minimum hatch duration', ErrorCode.GameConfig)
    const seconds = Math.max(minimum, Math.floor(eggConfig.eggTime * (1 - reduction) - fixed))
    ensure(Number.isSafeInteger(seconds) && seconds > 0, 'Invalid effective incubation duration', ErrorCode.GameConfig)
    return seconds
}
