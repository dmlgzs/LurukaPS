import { ErrorCode } from './error-codes.js'
import { productionTables } from './production-tables.js'
import { ensure } from './handlers/common.js'
import { hatchSeconds } from './hatching-time.js'

const catalogs = new WeakMap()
const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
function catalog(tables) {
    let data = catalogs.get(tables)
    if (!data) {
        data = {
            constants: new Map(tables.get('game').map((row) => [row.title, Number(row.value)])),
            talents: new Map(tables.get('home_talent').map((row) => [row.talentId, row])),
            technology: tables.get('home_technology'),
        }
        catalogs.set(tables, data)
    }
    return data
}

function matches(row, stationType) {
    const conditions = String(row.buffCondition ?? '')
        .split('|')
        .filter(Boolean)
        .map((token) => token.split('#').map(Number))
    const match = ([key, value]) => !key || (key === 2021 && value === stationType)
    return row.buffConditionLogic === 2 ? conditions.some(match) : conditions.every(match)
}

function buffValue(tables, rows, id, stationType) {
    const config = tables.find('home_buff', id)
    ensure(config, 'Missing production buff configuration', ErrorCode.GameConfig)
    let value = 0
    for (const row of rows) {
        if (!matches(row, stationType)) continue
        const ids = list(row.buffId),
            params = String(row.buffParams ?? '').split('|')
        for (let i = 0; i < ids.length; i++) {
            if (ids[i] !== id) continue
            const raw = Number(params[i]?.split('#')[0])
            ensure(Number.isFinite(raw), 'Invalid production buff value', ErrorCode.GameConfig)
            const v = config.type === 2 ? raw / 10000 : raw
            switch (config.algorithmType) {
                case 1:
                case 3:
                case 4:
                    value += v
                    break
                case 5:
                    value = (1 + value) * (1 + v) - 1
                    break
                case 6:
                    value = 1 - (1 - value) * (1 - v)
                    break
                case 7:
                    value = value === 0 ? v : Math.min(value, v)
                    break
                default:
                    ensure(false, 'Unsupported production buff algorithm', ErrorCode.FunctionClosed)
            }
        }
    }
    return value
}

export function productionSeconds(tables, state, build, recipe) {
    ensure(Number.isInteger(recipe.time) && recipe.time > 0, 'Invalid production duration', ErrorCode.HomeNoProductConf)
    const station = tables.find('home_building_production', build.build_id)
    ensure(station, 'Missing production station configuration', ErrorCode.BuildProductConfNotFound)
    const data = catalog(tables)
    const pet = state.pets?.find((entry) => entry.guid === String(build.station_pet_guid))
    const rows = (pet?.talent_id ?? []).map((id) => data.talents.get(id)).filter(Boolean)
    // Client GetAllCurTechnologyList uses the current level of each technology,
    // rather than adding every earlier level's effects again.
    for (const row of data.technology) if (state.home?.technology?.levels[row.type]?.level === row.level) rows.push(row)
    const fixed = buffValue(tables, rows, 5007, station.type)
    if (fixed !== 0) {
        ensure(Number.isInteger(fixed) && fixed > 0, 'Invalid fixed production duration', ErrorCode.HomeNoProductConf)
        return fixed
    }
    const reduction = buffValue(tables, rows, 2011, station.type)
    let laborReduction = 0
    if (pet && [2, 8, 10].includes(build.build_type)) {
        const types = list(station.laborType)
        // Match the client's iteration order when a pet has multiple eligible
        // abilities. The last matching labor entry supplies the grade.
        const labor = pet.labor_infos?.filter((entry) => types.includes(entry.labor_id)).at(-1)
        if (labor) {
            const efficiency = tables.find('home_labor_efficiency', labor.labor_grade)
            ensure(efficiency, 'Missing labor efficiency grade', ErrorCode.GameConfig)
            laborReduction =
                Math.max(0, Number(build.build_type === 8 ? efficiency.AccessoryTimeReduct : efficiency.TimeReduct)) /
                10000
            if (pet.satiety_val <= data.constants.get('PET_HOME_TIRED_SATIETY'))
                laborReduction *= data.constants.get('HOME_LABOR_PROCESS_DECREASE') / 10000
        }
    }
    const minimum = data.constants.get('HOME_PROCESS_PRODUCT_TIME')
    ensure(Number.isInteger(minimum) && minimum > 0, 'Invalid minimum production duration', ErrorCode.HomeNoProductConf)
    const seconds = Math.floor(Math.max(minimum, recipe.time * (1 - reduction) * (1 - laborReduction)))
    ensure(
        Number.isSafeInteger(seconds) && seconds > 0,
        'Invalid effective production duration',
        ErrorCode.HomeNoProductConf,
    )
    return seconds
}

export function retimeProduction(tables, state, now) {
    tables = productionTables(tables)
    let changed = false
    for (const build of state.home?.builds ?? []) {
        const jobs = state.home.productionJobs?.[build.guid] ?? []
        const updates = jobs.map((job) => {
            if (job.workEpoch !== undefined) return job.seconds
            if (now >= job.start + job.count * job.seconds) return job.seconds
            if (job.kind === 'hatch') {
                const egg = state.petEggs?.find((e) => e.guid === job.eggGuid)
                ensure(egg, 'Hatch egg missing', ErrorCode.EggNotExist)
                return hatchSeconds(tables, state, build, tables.find('pet_egg', egg.configid))
            }
            const recipe = tables.find(job.kind === 'accessory' ? 'accessory_product' : 'products', job.productId)
            return recipe
                ? productionSeconds(
                      tables,
                      state,
                      build,
                      job.kind === 'accessory' ? { ...recipe, time: recipe.time * 60 } : recipe,
                  )
                : job.seconds
        })
        if (!jobs.some((job, i) => job.seconds !== updates[i])) continue
        let end = now
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i],
                seconds = updates[i]
            if (job.workEpoch !== undefined) {
                end = Math.max(end, job.workProjection?.total_finish_time ?? now)
                continue
            }
            if (now >= job.start + job.count * job.seconds) continue
            if (job.start <= now) {
                const progress = (now - job.start) / job.seconds
                // Keep completed units and the current unit's proportional work.
                // Ceil keeps integer wire timestamps without awarding work early.
                job.start = Math.ceil(now - progress * seconds)
            } else job.start = end
            job.seconds = seconds
            end = job.start + job.count * seconds
        }
        changed = true
    }
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return changed
}
