import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { selectBaseHatchSpecies } from './egg-pools.js'
import { createPets } from './pets.js'
import { hatchSeconds } from './hatching-time.js'
export function hatchBuilding(state, guid) {
    const b = state.home?.builds.find((b) => b.guid === guid)
    ensure(b?.build_type === 12, 'An owned, placed hatch building is required')
    ensure([1, 4].includes(b.status), 'Hatch building is unavailable')
    return b
}
export function startHatch(c, buildGuid, eggGuid) {
    const b = hatchBuilding(c.state, buildGuid)
    const egg = (c.state.petEggs || []).find((e) => e.guid === eggGuid)
    ensure(egg, 'Pet egg not owned')
    ensure(!egg.lock_state, 'Pet egg is locked')
    ensure(!egg.hatch_state && !egg.hatch_build_guid, 'Pet egg is already assigned')
    ensure(
        !egg.egg_affix?.length && !egg.main_parents && !egg.secondary_parents,
        'Affix and inherited hatch generation is not yet implemented',
        ErrorCode.InvalidProtoID,
    )
    const config = c.tables.find('pet_egg', egg.configid),
        station = c.tables.find('home_building_production', b.build_id)
    ensure(config, 'Missing egg configuration', ErrorCode.EggConfNotExist)
    ensure(station, 'Missing hatch station configuration', ErrorCode.BuildProductConfNotFound)
    ensure(Number.isInteger(config.eggTime) && config.eggTime > 0, 'Invalid incubation duration', ErrorCode.GameConfig)
    const seconds = hatchSeconds(c.tables, c.state, b, config)
    const home = c.state.home
    home.productionJobs ??= {}
    const jobs = home.productionJobs[b.guid] || []
    ensure(jobs.length < station.productionQueueNum, 'Hatch queue is full')
    ensure(
        jobs.every((j) => j.kind === 'hatch'),
        'Station has a different production queue',
    )
    c.state.eggOutcomes ??= {}
    if (!c.state.eggOutcomes[eggGuid])
        c.state.eggOutcomes[eggGuid] = selectBaseHatchSpecies(
            c.tables,
            egg.configid,
            c.randomInt,
            c.state.eggHatchConstraints?.[eggGuid],
        )
    const start = Math.max(c.now, ...jobs.map((j) => j.start + j.seconds)),
        guid = home.nextProductGuid || 1
    ensure(start + seconds <= 0xffffffff && guid <= 0xffffffff, 'Hatch identity/timestamp exhausted')
    home.nextProductGuid = guid + 1
    jobs.push({
        kind: 'hatch',
        eggGuid,
        petId: c.state.eggOutcomes[eggGuid],
        guid,
        productId: config.product,
        count: 1,
        claimed: 0,
        start,
        seconds,
        costs: [],
        rewards: [],
        reportedDone: 0,
    })
    home.productionJobs[b.guid] = jobs
    egg.hatch_build_guid = b.guid
    c.state.eggRevision = (c.state.eggRevision || 0) + 1
}
export function claimHatch(c, job) {
    ensure(c.now >= job.start + job.seconds, 'Egg has not finished hatching')
    const egg = (c.state.petEggs || []).find((e) => e.guid === job.eggGuid)
    ensure(egg && egg.hatch_build_guid, 'Hatch egg missing')
    const builderRuleId = c.tables.find('pet_egg', egg.configid)?.petBuilderRuleId
    ensure(c.tables.find('pet_builder_rule', builderRuleId), 'Missing egg pet builder', ErrorCode.GameConfig)
    const [pet] = createPets(c.tables, c.state, job.petId, 1, builderRuleId)
    c.state.petEggs = c.state.petEggs.filter((e) => e.guid !== job.eggGuid)
    delete c.state.eggOutcomes[job.eggGuid]
    if (c.state.eggHatchConstraints) delete c.state.eggHatchConstraints[job.eggGuid]
    c.state.eggRevision = (c.state.eggRevision || 0) + 1
    job.claimed = 1
    return { itemtype: 5, itemid: job.petId, itemnum: 1, guid: pet.guid }
}
export function cancelHatch(c, job) {
    const egg = (c.state.petEggs || []).find((e) => e.guid === job.eggGuid)
    ensure(egg, 'Hatch egg missing')
    egg.hatch_state = 0
    egg.hatch_build_guid = 0
    c.state.eggRevision = (c.state.eggRevision || 0) + 1
}
