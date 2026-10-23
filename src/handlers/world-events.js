import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { grantRewards } from '../rewards.js'
import { u64, combatState, boundedSet } from '../combat-state.js'
import { enemyDefinition } from '../enemy-state.js'
import { admitWorldEvent, checkWorldEventConditions, worldEventAdmitted } from '../world-event-runtime.js'
function wire(record) {
    return {
        cfg_id: record.cfg_id,
        step: record.step,
        next_trigger_time: record.next_trigger_time,
        begin_time: record.begin_time,
    }
}
export function registerWorldEvents(on, tables) {
    const drops = new WorldObjectCatalog(tables)
    const configuredDrops = new Set(drops.get('drop').map((entry) => entry.dropId))
    const eventRewards = (c, row) => {
        const rewards = []
        for (const token of String(row.dropID || '')
            .split('|')
            .filter(Boolean)) {
            const id = Number(token)
            ensure(Number.isInteger(id) && id > 0, 'Invalid world event drop', ErrorCode.GameConfig)
            if (!configuredDrops.has(id)) {
                // CBT3 keeps disabled placeholder events (100/107/108/109/117)
                // with drop IDs absent from the shipped drop table.
                ensure(
                    row.probability === 0 && row.weight === 0,
                    'Active world event references an unknown drop',
                    ErrorCode.GameConfig,
                )
                continue
            }
            rewards.push(...drops.drops(id, c.randomInt))
        }
        return grantRewards(c.tables, c.state, rewards)
    }
    const config = (c, id) => {
        ensure(
            Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff,
            'Invalid world event ID',
            ErrorCode.InvalidArgument,
        )
        const row = tables.find('world_event', id)
        ensure(row, 'World event configuration is missing', ErrorCode.WorldEventConfNotFound)
        ensure(row.worldMapID === c.state.world.map_id, 'Event not in current map', ErrorCode.InvalidArgument)
        ensure(row.stepCount >= 2, 'Invalid event step configuration', ErrorCode.GameConfig)
        return row
    }
    const trigger = (c, row) => {
        const events = (c.state.worldEvents ??= {}),
            key = `${row.worldMapID}:${row.id}`
        let event = events[key]
        if (event?.rewarded && row.dropID && event.step === row.stepCount - 1) {
            // Old servers awarded the drop one step early. Preserve that
            // receipt; the client's final callback still needs an ack.
            event.completed = true
            event.expired = false
        } else if (event?.completed && event.step === row.stepCount - 1) event.completed = false
        if (
            event &&
            !event.completed &&
            event.step < row.stepCount &&
            row.overtime > 0 &&
            c.now >= event.begin_time + row.overtime
        ) {
            event.step = row.overtimeResult
            event.expired = true
        }
        const failedRetry =
            event?.expired &&
            !event.rewarded &&
            c.now >= event.begin_time + Math.max(0, row.overtime) + Math.max(0, row.checkCD)
        if (!event || failedRetry || ((event.completed || event.expired) && c.now >= event.next_trigger_time)) {
            const recoverFinalUntil =
                row.id === 203 && event?.expired && event.generation === 1 && c.now - event.begin_time >= 86400
                    ? c.now + 600
                    : 0
            event = {
                cfg_id: row.id,
                step: 1,
                begin_time: c.now,
                next_trigger_time: c.now + Math.max(0, row.refreshCD),
                generation: (event?.generation ?? 0) + 1,
                completed: false,
                expired: false,
                rewarded: false,
                ...(recoverFinalUntil ? { recoverFinalUntil } : {}),
            }
            events[key] = event
        }
        return event
    }
    const syncEvent = (c, row, event) => {
        // Publishing10715 reauthorizes an actually accepted generation, including
        // reconnect continuation. Do not re-check a condition that changed after admission.
        admitWorldEvent(c, row, event)
        c.pushBefore('CSProtoWorldEventInfo', { infos: [wire(event)] })
    }
    on('WorldEventTrigger', (c, r) => {
        const row = tables.find('world_event', r.cfg_id)
        // The old world can keep polling nearby events while a dungeon scene is
        // loading. Acknowledge them without starting that event in the dungeon.
        if (c.state.multiCampaign && row && row.worldMapID !== c.state.world.map_id) return { infos: [] }
        const configured = config(c, r.cfg_id),
            event = trigger(c, configured)
        if (!worldEventAdmitted(c, configured, event)) checkWorldEventConditions(c, configured)
        admitWorldEvent(c, configured, event)
        return { infos: [wire(event)] }
    })
    on('WorldEventStep', (c, r) => {
        const row = config(c, r.cfg_id),
            key = `${row.worldMapID}:${row.id}`,
            event = c.state.worldEvents?.[key]
        ensure(event, 'Event not started')
        if (row.conditionID)
            ensure(
                worldEventAdmitted(c, row, event),
                'World event generation was not admitted',
                ErrorCode.WorldEvCondition,
            )
        const step = r.step
        // stepCount includes the initial step. The client reports the last
        // transition as stepCount (event 201: start + three monster waves).
        ensure(Number.isInteger(step) && step >= 1 && step <= row.stepCount, 'Invalid event transition')
        if (event.rewarded && row.dropID && event.step === row.stepCount - 1) {
            event.completed = true
            event.expired = false
            if (step === row.stepCount) event.step = step
            ensure(step === event.step, 'Event restart must follow cooldown')
            syncEvent(c, row, event)
            return { rewards: [] }
        }
        if (
            row.id === 203 &&
            !event.rewarded &&
            ((event.expired && event.generation === 1 && c.now - event.begin_time >= 86400) ||
                (event.generation === 2 && event.step === 1 && event.recoverFinalUntil >= c.now)) &&
            step === row.stepCount &&
            r.event_type === row.triggerType &&
            !r.reset_start
        ) {
            // An old server retained a failed egg event for its full 70-hour
            // reward cooldown. The client finished a fresh nearby event, but
            // its final step was compared with that stale generation.
            const targetId = Number(String(row.targetParamList).split(/[|#]/)[0]),
                target = drops.object(row.worldMapID, targetId).pos,
                near = (pos) =>
                    pos &&
                    ['x', 'y', 'z'].every((axis) => Number.isFinite(pos[axis])) &&
                    ['x', 'y', 'z'].reduce((sum, axis) => sum + (pos[axis] - target[axis]) ** 2, 0) <= 10000 ** 2
            ensure(
                near(c.state.world.pos) &&
                    near({
                        x: Math.round(r.pos?.x * 100),
                        y: Math.round(r.pos?.y * 100),
                        z: Math.round(r.pos?.z * 100),
                    }),
                'Stale egg event is not nearby',
            )
            event.expired = false
            event.step = row.stepCount - 1
            event.begin_time = c.now
            event.next_trigger_time = c.now + Math.max(0, row.refreshCD)
            event.generation++
            delete event.recoverFinalUntil
        }
        // Older servers marked stepCount - 1 as complete. Let an interrupted
        // event advance to the real final step without restarting the waves.
        if (event.completed && event.step === row.stepCount - 1) event.completed = false
        if (event.completed) {
            ensure(step === event.step, 'Event restart must follow cooldown')
            syncEvent(c, row, event)
            return { rewards: [] }
        }
        const timedOut = row.overtime > 0 && c.now >= event.begin_time + row.overtime
        if (timedOut && !event.expired) {
            event.expired = true
            event.step = row.overtimeResult
        }
        if (event.expired) {
            // ForceReqSetStep sends reset_start when the configured overtime
            // resolves an event. Commit that final step once and start the
            // normal refresh cooldown; echoing the old expired state makes
            // the client retry this packet forever.
            ensure(r.reset_start && step === event.step && step === row.overtimeResult, 'Event expired')
            event.expired = false
            event.step = step
            event.begin_time = c.now
            event.next_trigger_time = c.now + Math.max(0, row.refreshCD)
            let rewards = []
            if (step === row.stepCount) {
                if (!event.rewarded) {
                    rewards = eventRewards(c, row)
                    event.rewarded = true
                }
                event.completed = true
                if (rewards.length) syncPlayer({ ...c, push: c.pushBefore })
            }
            syncEvent(c, row, event)
            return { rewards }
        }
        ensure(!timedOut, 'Event expired')
        ensure(r.reset_start || (step >= event.step && step <= event.step + 1), 'Invalid event transition')
        let rewards = []
        if (step !== event.step) {
            event.step = step
            delete event.recoverFinalUntil
            if (r.reset_start) {
                event.begin_time = c.now
                event.next_trigger_time = c.now + Math.max(0, row.refreshCD)
            }
        }
        if (step === row.stepCount) {
            if (!event.rewarded) {
                rewards = eventRewards(c, row)
                event.rewarded = true
            }
            event.completed = true
            if (rewards.length) syncPlayer({ ...c, push: c.pushBefore })
        }
        syncEvent(c, row, event)
        return { rewards }
    })
    on('MonsterSceneChange', (c, r) => {
        const infos = r.infos ?? []
        ensure(Array.isArray(infos) && infos.length <= 256, 'Invalid monster scene batch')
        if (!infos.length) return
        const battle = combatState(c.state, c.now)
        battle.monsterScenes ??= {}
        const objects = new Map(tables.get(`worldmap_${c.state.world.map_id}`).map((row) => [row.id, row]))
        const playableMonsters = new Set(
            Object.entries(c.state.playableEnemies ?? {})
                .filter(([key]) => key.startsWith(`${c.state.world.map_id}:`))
                .flatMap(([, entry]) => entry.entities.map((entity) => entity.uuid)),
        )
        const eventTargets = new Set()
        for (const [key, event] of Object.entries(c.state.worldEvents ?? {})) {
            if (!key.startsWith(`${c.state.world.map_id}:`) || event.expired) continue
            const row = tables.find('world_event', event.cfg_id)
            for (const value of String(row?.targetParamList ?? '').split('|')) {
                const id = Number(value.split('#')[0])
                if (Number.isInteger(id) && id > 0) eventTargets.add(id)
            }
        }
        for (const info of infos) {
            const id = u64(info.tar_id),
                value = BigInt(id),
                kind = Number(value >> 56n),
                objectId = Number(value & 0xffffffffn),
                scene = info.scene ?? 0,
                worldObject = objects.get(objectId),
                spawner = worldObject && tables.find('world_spawner', worldObject.spawnerId)
            ensure([0, 1, 2, 3].includes(scene), 'Invalid monster scene')
            ensure(
                (kind === 3 && (spawner?.objectType === 50 || eventTargets.has(objectId))) ||
                    (kind === 7 && playableMonsters.has(id)) ||
                    (kind === 4 && !!enemyDefinition(tables, c.state, id)),
                'Unknown scene monster',
            )
            boundedSet(battle.monsterScenes, id, { scene, updated_at: c.now }, 512)
        }
    })
    on('TaskRandomArea', (c, r) => {
        ensure(Number.isInteger(r.u32) && r.u32 > 0, 'Invalid random task group')
        const groups = tables.get('task_randomgroup')
        ensure(
            groups.length === 0,
            'Configured random task selection needs scheduling support',
            ErrorCode.FunctionClosed,
        )
        c.state.randomTaskQuery = { group_id: r.u32, time: c.now }
        c.pushBefore('CSProtoTaskRandomAreaSync', { time: c.now, areas_ids: [], task_ids: [] })
        return {}
    })
}
