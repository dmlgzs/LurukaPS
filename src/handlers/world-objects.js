import { petPuzzleRule } from '../pet-puzzles.js'
import { registerWorldElevator } from './world-elevator.js'
import { rewardSource } from '../reward-source.js'
import { ensure, syncPlayer } from './common.js'
import { settleStoryCampaignScene } from './story-campaign.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { grantRewards, parseRewards } from '../rewards.js'
import { spend, spendCurrency } from '../inventory.js'
import { applyRepairVisuals } from '../world-repairs.js'
import { randomInt } from 'node:crypto'
import { completeEntrustObject, validateEntrustObjectInteraction } from './entrust.js'
import { taskNodeCompleted } from '../tasks.js'
// World resource prefabs do not expose their drop ID in worldmap/world_spawner.
// These IDs match the shipped resource variants and their configured drop pools.
const collectionFinalDrops = new Map([
    [650010, 44001],
    [650020, 44003],
    [650030, 44004],
    [650170, 41091],
    [650180, 41092],
    [650190, 41001],
    [650270, 43012],
    [650290, 43001],
    [650291, 43001],
    [650310, 43004],
    [650320, 43005],
    [650340, 43002],
    [650560, 42091],
    [650890, 41093],
    [650910, 44002],
    [651004, 41095],
    [651006, 41094],
    [651013, 43011],
    [651014, 43011],
])
export function worldCondition(value, state) {
    if (!value) return true
    return String(value)
        .split('|')
        .every((part) => {
            const [kind, a, b, ...extra] = part.split('#').map(Number)
            ensure(!extra.length && [kind, a].every(Number.isInteger), 'Invalid world object condition', 1007)
            if (kind === 2004) return state.player.basic_info.lv >= a
            if (kind === 2007)
                return (state.taskRecords ?? []).some((record) => record.task_id === a && record.count > 0)
            if (kind === 12045) {
                ensure(Number.isInteger(b) && b > 0, 'Invalid task-step appearance condition', 1007)
                return taskNodeCompleted(state, a, b)
            }
            ensure(false, `Unsupported world object condition ${kind}`, 1007)
        })
}
function stateData(input, depth = 0) {
    ensure(depth < 8 && (input.children ?? []).length <= 64, 'World state nesting limit')
    const result = {}
    for (const key of ['step', 'cur_hp'])
        if (input[key] !== undefined) {
            ensure(Number.isInteger(input[key]) && input[key] >= 0, 'Invalid world state')
            result[key] = input[key]
        }
    if (input.complete !== undefined) result.complete = !!input.complete
    if (input.children?.length) result.children = input.children.map((x) => stateData(x, depth + 1))
    return result
}
function collectingRows(catalog, spawnerId) {
    return catalog.get('world_collecting').filter((row) =>
        String(row.spawnerId)
            .split('|')
            .some((id) => Number(id) === spawnerId),
    )
}
function collectionReward(catalog, spawner, collecting) {
    const dropId = collectionFinalDrops.get(spawner.resourceId)
    const primary =
        dropId &&
        catalog
            .get('drop')
            .find((row) => row.dropId === dropId && row.dropGroupId === 1 && row.type === 3 && row.itemId > 0)
    const ordinary = primary
        ? { itemtype: primary.type, itemid: primary.itemId, itemnum: 1 }
        : collecting.length
          ? { itemtype: collecting[0].itemType, itemid: collecting[0].itemId, itemnum: 1 }
          : null
    return { dropId, ordinary }
}
export function reconcileWorldCollectionFinalDrops(tables, state) {
    const catalog = new WorldObjectCatalog(tables)
    let changed = false
    for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
        if (!record.complete || !record.claims?.complete) continue
        const [map, id] = key.split(':').map(Number)
        if (!Number.isInteger(map) || !Number.isInteger(id)) continue
        let row
        try {
            row = catalog.find('worldmap_' + map, id)
        } catch (error) {
            if (error.code === 'ENOENT') continue
            throw error
        }
        const spawner = row && catalog.find('world_spawner', row.spawnerId)
        if (!spawner || row.statusReward) continue
        const collecting = collectingRows(catalog, spawner.id)
        const { dropId } = collectionReward(catalog, spawner, collecting)
        if (!dropId) continue
        if (!record.claims.finalDrop_v2) {
            grantRewards(tables, state, catalog.drops(dropId, randomInt))
            record.claims.finalDrop_v2 = true
            changed = true
        }
        const lastStage = Math.min(4, Math.max(0, record.state_data?.step ?? 0))
        for (let step = 1; step <= lastStage; step++) {
            const stageKey = `step:${step}`
            if (record.claims[stageKey]) continue
            grantRewards(tables, state, catalog.drops(dropId, randomInt))
            record.claims[stageKey] = true
            changed = true
        }
    }
    return changed
}
export function registerWorldObjects(on, tables) {
    registerWorldElevator(on, tables)
    const catalog = new WorldObjectCatalog(tables)
    on('WorldCommonRepair', (c, r) => {
        const config = tables.find('common_world_repair', r.repair_id)
        ensure(config, 'Unknown world repair', 12045)
        ensure(
            config.cityId === c.state.world.map_id && config.worldmapId === r.obj_id,
            'Repair does not belong to this object/map',
            12046,
        )
        const { row } = catalog.object(c.state.world.map_id, r.obj_id)
        ensure(worldCondition(row.appearCond, c.state), 'Repair object is not available')
        const key = `${c.state.world.map_id}:${r.obj_id}`,
            records = (c.state.worldObjects ??= {}),
            old = records[key]
        if (old?.complete || old?.claims?.repair) {
            const objects = applyRepairVisuals(tables, c.state, c.state.world.map_id, r.obj_id, catalog)
            if (objects.length)
                c.pushBefore('CSProtoWorldMapSync', {
                    cmd: 2,
                    map_id: c.state.world.map_id,
                    map_info: {
                        creator_id: c.id,
                        map_id: c.state.world.map_id,
                        exist: true,
                        area_id: c.state.world.area_id,
                        objs: objects,
                    },
                })
            const { claims, ...obj } = old
            return { obj, rewards: { rewards: [] } }
        }
        const costs = parseRewards(config.cost),
            bag = new Map()
        ensure(
            costs.every((item) => [3, 10].includes(item.itemtype)),
            'Unsupported repair material',
            1007,
        )
        for (const cost of costs) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        if (bag.size) spend(c.state, bag, 0, c.now)
        const budget = { count: 0 }
        const rewardRows = parseRewards(config.reward).flatMap((reward) => {
            if (reward.itemtype !== 27) return [reward]
            ensure(reward.itemnum <= 512, 'Repair drop roll limit', 1007)
            return Array.from({ length: reward.itemnum }, () =>
                catalog.drops(reward.itemid, c.randomInt, budget),
            ).flat()
        })
        const rewards = grantRewards(tables, c.state, rewardRows)
        const record = {
            ...old,
            obj_id: r.obj_id,
            complete: true,
            state_data: { ...old?.state_data, step: 1, complete: true },
            claims: { ...old?.claims, repair: { id: r.repair_id, time: c.now } },
        }
        records[key] = record
        const objects = applyRepairVisuals(tables, c.state, c.state.world.map_id, r.obj_id, catalog)
        c.pushBefore('CSProtoWorldMapSync', {
            cmd: 2,
            map_id: c.state.world.map_id,
            map_info: {
                creator_id: c.id,
                map_id: c.state.world.map_id,
                exist: true,
                area_id: c.state.world.area_id,
                objs: objects,
            },
        })
        syncPlayer({ ...c, push: c.pushBefore })
        const { claims, ...obj } = record
        return { obj, rewards: { rewards } }
    })
    on('WorldObjInteract', (c, r) => {
        const requested = r.objs ?? []
        ensure(requested.length <= 64, 'Too many object interactions')
        const records = (c.state.worldObjects ??= {}),
            output = []
        let awarded = false
        for (const input of requested) {
            const id = input.obj?.obj_id,
                { row, spawner, pos } = catalog.object(c.state.world.map_id, id),
                key = `${c.state.world.map_id}:${id}`,
                old = records[key] ?? {
                    obj_id: id,
                    complete: !!row.initialCompleteState,
                    last_reward_step: 0,
                    state_data: { step: 0, complete: false },
                }
            ensure([0, 1, 2].includes(input.interact_type ?? 0), 'Unknown world interaction mode')
            const incoming = stateData(input.obj.state_data ?? {}),
                step = incoming.step ?? old.state_data?.step ?? 0
            const puzzle = petPuzzleRule(tables, row, spawner)
            ensure(puzzle || step >= (old.state_data?.step ?? 0), 'World state cannot move backwards')
            const full = !!input.obj.complete,
                stage = !!incoming.complete,
                stageAdvanced = step > (old.state_data?.step ?? 0),
                // CommonState.complete means solved; TryInteractObject separately
                // sets WorldObj.complete when collecting the resulting chest.
                claim = full || (!puzzle && stage)
            validateEntrustObjectInteraction(c, id, claim)
            const drops = String(row.statusReward || '')
                .split('|')
                .filter(Boolean)
                .map(Number)
            ensure(
                drops.every((x) => Number.isInteger(x) && x > 0),
                'Invalid world reward mapping',
                1007,
            )
            const record = {
                ...old,
                state_data: { ...old.state_data, ...incoming, ...(puzzle ? { children: incoming.children ?? [] } : {}) },
                time: old.complete ? old.time : c.now,
                pos,
                complete: old.complete || full,
            }
            if (puzzle) record.active = record.complete ? !!row.keepOnComplete : (old.active ?? true)
            const claims = old.claims ?? {}
            let rewards = [],
                dropIds = []
            const collecting = !drops.length ? collectingRows(catalog, spawner.id) : [],
                stageKey = `step:${step}`,
                pending = collecting.length
                    ? (!full && (stage || stageAdvanced) && !claims[stageKey]) || (full && !claims.complete)
                    : !claims[full ? 'complete' : stageKey]
            if ((claim || (collecting.length && stageAdvanced)) && !old.complete && pending) {
                const delta = ['x', 'y', 'z'].reduce((n, axis) => n + (c.state.world.pos[axis] - pos[axis]) ** 2, 0)
                const nearObject = (value) =>
                    value &&
                    ['x', 'y', 'z'].every(
                        (axis) => Number.isInteger(value[axis]) && Math.abs(value[axis] - pos[axis]) <= 200,
                    )
                const remoteStateOnly =
                    spawner.objectType === 12 &&
                    !drops.length &&
                    !collecting.length &&
                    input.interact_type === 2 &&
                    input.element_id > 0 &&
                    nearObject(input.pos) &&
                    nearObject(input.obj?.pos)
                ensure(delta <= 5000 ** 2 || remoteStateOnly, 'Object is too far away')
                ensure(
                    worldCondition(row.appearCond, c.state) &&
                        (!row.disappearCond || !worldCondition(row.disappearCond, c.state)),
                    'World object is not currently visible',
                )
                if (drops.length) {
                    const index = full ? drops.length - 1 : Math.max(0, step - 1)
                    ensure(index < drops.length, 'World reward step outside configuration')
                    if (!claims[`drop:${index}`]) {
                        dropIds = [drops[index]]
                        rewards = catalog.drops(drops[index], c.randomInt)
                        claims[`drop:${index}`] = true
                    }
                } else if (collecting.length) {
                    const { dropId, ordinary } = collectionReward(catalog, spawner, collecting)
                    if (!full && (stage || stageAdvanced) && !claims[stageKey]) {
                        if (dropId) {
                            rewards.push(...catalog.drops(dropId, c.randomInt))
                            dropIds.push(dropId)
                        } else if (ordinary) rewards.push(ordinary)
                        claims[stageKey] = true
                    }
                    if (full && !claims.complete) {
                        if (dropId) {
                            rewards.push(...catalog.drops(dropId, c.randomInt))
                            dropIds.push(dropId)
                            claims.finalDrop_v2 = true
                        } else
                            rewards.push(
                                ...collecting.map((entry) => ({
                                    itemtype: entry.itemType,
                                    itemid: entry.itemId,
                                    itemnum: 1,
                                })),
                            )
                        claims.complete = true
                    }
                }
                if (rewards.length) {
                    rewards = grantRewards(c.tables, c.state, rewards)
                    awarded = true
                }
                if (!collecting.length) claims[full ? 'complete' : stageKey] = true
                record.last_reward_step = Math.max(old.last_reward_step ?? 0, step)
            }
            record.claims = claims
            records[key] = record
            if (collectionFinalDrops.has(spawner.resourceId)) {
                const trace = (c.state.worldObjectRewardTrace ??= [])
                trace.push({
                    time: c.now,
                    obj_id: id,
                    old_step: old.state_data?.step ?? 0,
                    step,
                    stage_complete: stage,
                    obj_complete: full,
                    cur_hp: incoming.cur_hp,
                    drop_ids: dropIds,
                })
                if (trace.length > 64) trace.shift()
            }
            const { claims: ignored, ...wire } = record
            output.push({
                obj: wire,
                pos,
                rewards: { rewards, src: rewardSource(c.tables, 'worldObjectInteract') },
                drop_ids: dropIds,
                interact_type: input.interact_type ?? 0,
                tool_type: input.tool_type ?? 0,
            })
            const entrustRewards = completeEntrustObject(c, id, claim)
            const { claims: currentClaims, ...currentWire } = records[key]
            output[output.length - 1].obj = currentWire
            if (entrustRewards.length) {
                output[output.length - 1].rewards.rewards.push(...entrustRewards)
                awarded = true
            }
        }
        if (awarded) syncPlayer({ ...c, push: c.pushBefore })
        settleStoryCampaignScene(c)
        return { objs: output }
    })
}
