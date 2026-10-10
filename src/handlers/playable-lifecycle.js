import fs from 'node:fs'
import { ensure, syncPlayer } from './common.js'
import { spend, spendCurrency } from '../inventory.js'
import { rewardSource } from '../reward-source.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { TaskGraphs, nodeConditions } from '../tasks.js'
import { grantRewards, parseRewards } from '../rewards.js'
const configs = new Map(
    JSON.parse(fs.readFileSync(new URL('../../configs/playable-tables/playable.json', import.meta.url))).map((r) => [
        r.id,
        r,
    ]),
)
// Only confirmed empty rewards are listed here. Unknown missing drops still
// fail; if the original table later supplies a group, its real rewards win.
const emptyScoreRewards = new Set(
    JSON.parse(fs.readFileSync(new URL('../../configs/playable-empty-rewards.json', import.meta.url))).map(
        (row) => row.play_id + ':' + row.drop_id,
    ),
)
export function playableSnapshot(state) {
    const finish = Object.values(state.playableFinishes ?? {}).filter((r) => r.map_id === state.world.map_id)
    return {
        plays: Object.values(state.playableRuns ?? {})
            .filter((r) => r.map_id === state.world.map_id && r.status !== 3)
            .map(
                ({
                    map_id,
                    selected_step,
                    selected_pet_group,
                    selected_pet_guid,
                    rewarded_steps,
                    prior_reward_info,
                    ...r
                }) => r,
            ),
        finish_plays: finish.map((r) => r.play_id),
        finish: finish.map(({ play_id, score, reward_info }) => ({ play_id, score, reward_info })),
        step_flags: Object.entries(state.playableStageClaims ?? {})
            .filter(([, entry]) => entry.map_id === state.world.map_id)
            .map(([id, entry]) => ({ play_id: Number(id), flag: entry.flag })),
        all_sync: true,
    }
}
const recoveryGraphs = new WeakMap()
export function recoverInterruptedFlyTravel(tables, state) {
    const id = 62035,
        run = state.playableRuns?.[id]
    if (
        !run ||
        run.map_id !== state.world.map_id ||
        run.status !== 1 ||
        run.finish_step !== 0 ||
        run.sub_datas?.length ||
        state.playableFinishes?.[id]
    )
        return false
    let graphs = recoveryGraphs.get(tables)
    if (!graphs) recoveryGraphs.set(tables, (graphs = new TaskGraphs(tables)))
    const active = (state.tasks ?? []).some((task) =>
        task.nodes.some((node) =>
            nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some((condition) => {
                const data = condition.__type_TaskConditionBaseData?.__type_TaskCondCompletePlayableData
                return (
                    condition.conditionId === 2525 &&
                    data?.playableId === id &&
                    data.playableData?.sceneId === run.map_id
                )
            }),
        ),
    )
    if (!active) return false
    // This flight's temporary mount and start callback live only in its graph.
    // Reopening a zero-step RUNNING receipt cannot restore those objects.
    // Return the still-active task to its start interaction; never mark it done.
    // TODO(62035, task106015/8): persist/resume temporary flight runtime if the
    // client protocol exposes a checkpoint; currently only zero-step runs reset.
    delete state.playableRuns[id]
    return true
}
export function registerPlayableLifecycle(on, tables) {
    const world = new WorldObjectCatalog(tables),
        graphs = new TaskGraphs(tables)
    const config = (id) => {
        const row = configs.get(id)
        ensure(row, 'Unknown playable')
        return row
    }
    // A zero stepMax means this playable has no fixed table maximum. The
    // client still sends its completion step (62026 sends step 1 after the
    // five local investigation interactions).
    const requiredStep = (row) => Math.max(1, row.stepMax)
    const stepLimit = (row) => (row.stepMax > 0 ? row.stepMax : 1024)
    // All-sync recycles every unit and destroys graph start subscriptions.
    // Ordinary lifecycle updates must keep the graph waiting for OnRealStart.
    // Login still uses playableSnapshot's full snapshot to rebuild the world.
    const sync = (c, extra = {}) =>
        c.pushBefore('CSProtoPlayableSync', { ...playableSnapshot(c.state), all_sync: false, ...extra })
    const taskForPlayable = (state, playId) =>
        state.tasks?.find((task) => {
            const graph = graphs.get(task.task_id)
            return task.nodes.some((node) =>
                nodeConditions(graph.nodes.get(node.node_id)).some((condition) => {
                    const base = condition.__type_TaskConditionBaseData,
                        d = base?.__type_TaskCondCompletePlayableData
                    return (
                        condition.conditionId === 2525 &&
                        d?.playableId === playId &&
                        (!base.mapData?.sceneId || base.mapData.sceneId === state.world.map_id) &&
                        d.playableData?.sceneId === state.world.map_id
                    )
                }),
            )
        })
    const activeTaskPlayable = (state, playId) => !!taskForPlayable(state, playId)
    const stageRewards = (row) =>
        new Map(
            String(row.stepRewards || '')
                .split('|')
                .filter(Boolean)
                .map((token) => {
                    const [step, drop, ...rest] = token.split('#').map(Number)
                    ensure(
                        !rest.length &&
                            Number.isInteger(step) &&
                            step > 0 &&
                            step < 64 &&
                            step <= stepLimit(row) &&
                            Number.isInteger(drop) &&
                            drop > 0,
                        'Invalid playable stage reward mapping',
                        1007,
                    )
                    return [step, drop]
                }),
        )
    const markStage = (state, row, map, step) => {
        const ledger = (state.playableStageClaims ??= {})
        const old = ledger[row.id]
        ledger[row.id] = { map_id: map, flag: String(BigInt(old?.flag ?? 0) | (1n << BigInt(step))) }
    }
    const selectPetChoice = (c, row, run, step, drop) => {
        const task = taskForPlayable(c.state, row.id)
        ensure(
            task && tables.get('drop').some((d) => d.dropId === drop && d.type === 30),
            'Invalid playable pet choice drop',
            1007,
        )
        const key = `${task.task_id}:${c.state.taskEpochs?.[task.task_id] ?? 0}:${row.id}`
        const receipts = (c.state.playableChoiceReceipts ??= {})
        let receipt = receipts[key],
            rewards = []
        if (receipt) {
            ensure(receipt.step === step, 'Playable pet choice already made')
            ensure(
                c.state.pets.some((p) => p.guid === receipt.pet_guid),
                'Recorded playable pet is missing',
                1007,
            )
        } else {
            rewards = grantRewards(tables, c.state, world.drops(drop, c.randomInt))
            ensure(rewards.length === 1 && rewards[0].itemtype === 30, 'Playable pet choice must grant one pet', 1007)
            const pet = c.state.pets.find((p) => p.guid === rewards[0].guid)
            const group = tables.get('pet_rank').find((rank) => rank.petId === pet?.config_id)?.petGroup
            ensure(Number.isInteger(group) && group > 0, 'Playable pet group unavailable', 1007)
            receipt = { step, drop_id: drop, pet_guid: pet.guid, pet_group: group }
            receipts[key] = receipt
        }
        run.selected_step = receipt.step
        run.selected_pet_group = receipt.pet_group
        run.selected_pet_guid = receipt.pet_guid
        ;(c.state.taskPetChoices ??= {})[task.task_id] = receipt.pet_group
        return { rewards, dropIds: rewards.length ? [drop] : [] }
    }
    on('PlayableStart', (c, r) => {
        const row = config(r.u32),
            runs = (c.state.playableRuns ??= {})
        // A late Start can race the task's completion callback. Acknowledge the
        // already-finished run without re-opening its choice or resending all_sync.
        if (
            row.id === 60001 &&
            runs[row.id]?.status === 3 &&
            c.state.playableFinishes?.[row.id]?.map_id === runs[row.id].map_id
        )
            return {}
        ensure(
            world.get('worldmap_' + c.state.world.map_id).some((o) => o.expandId === row.id) ||
                activeTaskPlayable(c.state, row.id) ||
                (row.parentID > 0 &&
                    runs[row.parentID]?.map_id === c.state.world.map_id &&
                    runs[row.parentID]?.status !== 3),
            'Playable is not in current map',
        )
        const previous = runs[row.id]
        const finished = c.state.playableFinishes?.[row.id]
        if (previous?.map_id === c.state.world.map_id && previous.status !== 3) return {}
        if (finished?.map_id === c.state.world.map_id && row.canReset !== 1) return {}
        const costs = parseRewards(row.cost, true).filter((cost) => cost.itemnum > 0)
        ensure(
            costs.every((cost) => [3, 10].includes(cost.itemtype)),
            'Unsupported playable entry cost',
            1007,
        )
        const bag = new Map()
        for (const cost of costs) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        if (bag.size) spend(c.state, bag, 0, c.now)
        if (costs.length) syncPlayer({ ...c, push: c.pushBefore })
        if (finished) {
            ;(c.state.playableScoreClaims ??= {})[row.id] = finished.reward_info ?? 0
            delete c.state.playableFinishes[row.id]
        }
        // Client simulator keeps children of the newly started parent, replaces other runs.
        if (!row.parentID)
            for (const [id, run] of Object.entries(runs))
                if (configs.get(run.play_id)?.parentID !== row.id) delete runs[id]
        runs[row.id] = {
            play_id: row.id,
            map_id: c.state.world.map_id,
            finish_step: 0,
            sub_datas: [],
            status: 1,
            time: c.now,
            prior_reward_info:
                c.state.playableScoreClaims?.[row.id] ?? finished?.reward_info ?? previous?.prior_reward_info ?? 0,
        }
        sync(c, finished ? { del_finish_plays: [row.id] } : {})
        return {}
    })
    on('PlayableCancel', (c, r) => {
        config(r.playId)
        const runs = (c.state.playableRuns ??= {})
        const removed = new Set([r.playId])
        let changed = true
        while (changed) {
            changed = false
            for (const [id, run] of Object.entries(runs))
                if (!removed.has(Number(id)) && removed.has(configs.get(run.play_id)?.parentID)) {
                    removed.add(Number(id))
                    changed = true
                }
        }
        for (const id of removed) delete runs[id]
        sync(c)
        return {}
    })
    on('PlayableStep', (c, r) => {
        const row = config(r.playId),
            run = c.state.playableRuns?.[row.id]
        ensure(run && run.map_id === c.state.world.map_id, 'Playable is not running')
        if (run.status === 3 && c.state.playableFinishes?.[row.id]?.map_id === run.map_id) {
            const {
                map_id,
                selected_step,
                selected_pet_group,
                selected_pet_guid,
                rewarded_steps,
                prior_reward_info,
                ...play
            } = run
            return { play, pos: c.state.world.pos, rewards: { rewards: [] }, drop_id: [] }
        }
        let rewards = [],
            dropIds = [],
            changed = false
        if (r.is_step) {
            const step = r.finish_step ?? 0
            ensure(
                Number.isInteger(step) && step >= 0 && step >= run.finish_step && step <= stepLimit(row),
                'Invalid playable step',
            )
            const drop = stageRewards(row).get(step)
            if (row.id === 60001 && drop) {
                ensure(!run.selected_step || run.selected_step === step, 'Playable pet choice already made')
                ;({ rewards, dropIds } = selectPetChoice(c, row, run, step, drop))
                markStage(c.state, row, run.map_id, step)
            } else if (drop && !(BigInt(c.state.playableStageClaims?.[row.id]?.flag ?? 0) & (1n << BigInt(step)))) {
                ensure(
                    world.get('drop').some((entry) => entry.dropId === drop),
                    `Unknown world drop ${drop} for playable ${row.id} stage ${step}`,
                    1007,
                )
                rewards = grantRewards(tables, c.state, world.drops(drop, c.randomInt))
                dropIds = [drop]
                markStage(c.state, row, run.map_id, step)
            }
            if (row.id === 60001 && step === row.stepMax) ensure(run.selected_step, 'Playable pet choice is missing')
            const status = step >= requiredStep(row) ? 2 : 1
            changed = run.finish_step !== step || run.status !== status || dropIds.length > 0
            run.finish_step = step
            run.status = status
        } else {
            const subs = r.sub_datas ?? []
            ensure(subs.length <= 256, 'Too many playable substeps')
            for (const sub of subs) {
                ensure(
                    Number.isInteger(sub.sub_id) && sub.sub_id >= 0 && sub.sub_id <= 0xffffffff,
                    'Invalid playable substep',
                )
                const existing = run.sub_datas.find((s) => s.sub_id === sub.sub_id)
                const next = { sub_id: sub.sub_id, finish_step: sub.finish_step ?? 0, complete: !!sub.complete }
                // PlayableObject state is a reversible enum, independent of the parent progress.
                ensure(
                    Number.isInteger(next.finish_step) && next.finish_step >= 0 && next.finish_step <= 0xffffffff,
                    'Invalid playable substep state',
                )
                if (existing) {
                    if (existing.finish_step !== next.finish_step || existing.complete !== next.complete) changed = true
                    Object.assign(existing, next)
                } else {
                    ensure(run.sub_datas.length < 256, 'Playable substep limit')
                    run.sub_datas.push(next)
                    changed = true
                }
            }
        }
        // SCPlayableStep only calls SetStep on the client; it does not set
        // stateComplete. Publish status2 through PlayableSync before Finish
        // removes the run, otherwise OnPlayableSync force-resets its objects.
        if (rewards.length) syncPlayer({ ...c, push: c.pushBefore })
        if (changed || run.status === 2) sync(c)
        const {
            map_id,
            selected_step,
            selected_pet_group,
            selected_pet_guid,
            rewarded_steps,
            prior_reward_info,
            ...play
        } = run
        return {
            play,
            pos: c.state.world.pos,
            rewards: { rewards, ...(rewards.length ? { src: rewardSource(tables, 'playableStep') } : {}) },
            drop_id: dropIds,
        }
    })
    on('PlayableFinish', (c, r) => {
        const row = config(r.playId),
            run = c.state.playableRuns?.[row.id]
        ensure(run && run.map_id === c.state.world.map_id, 'Playable is not running')
        const index = r.index ?? 0,
            score = r.score ?? 0
        ensure(
            Number.isInteger(index) && index >= 0 && Number.isInteger(score) && score >= 0,
            'Invalid playable finish',
        )
        const finished = (c.state.playableFinishes ??= {})
        if (!finished[row.id]) {
            ensure(run.finish_step >= requiredStep(row) && run.status === 2, 'Playable has not completed its steps')
            if (row.id === 60001)
                ensure(run.selected_pet_group && run.selected_pet_guid, 'Playable pet choice is missing')
            finished[row.id] = {
                play_id: row.id,
                map_id: run.map_id,
                score,
                reward_info: run.prior_reward_info ?? 0,
                selected_pet_group: run.selected_pet_group,
                selected_pet_guid: run.selected_pet_guid,
                finished_at: c.now,
            }
        }
        run.status = 3
        sync(c)
        return { playId: row.id, reward: { rewards: [] }, drop_id: [], pos: c.state.world.pos }
    })
    on('PlayableScoreReward', (c, r) => {
        const row = config(r.play_id),
            finish = c.state.playableFinishes?.[row.id]
        ensure(finish && finish.map_id === c.state.world.map_id, 'Playable reward is not available')
        const mask = BigInt(r.reward_info ?? '0'),
            claimed = BigInt(finish.reward_info ?? 0),
            dropIds = String(row.statusReward || '').split('|'),
            scores = String(row.playScore || '')
                .split('|')
                .filter(Boolean)
                .map(Number)
        ensure(mask > 0n && mask < 1n << 32n && !(mask & 1n), 'Invalid playable reward mask')
        const available = dropIds.reduce(
            (bits, token, index) =>
                token && Number(token) > 0 && (!scores.length || finish.score >= scores[index])
                    ? bits | (1n << BigInt(index + 1))
                    : bits,
            0n,
        )
        ensure((mask & ~available) === 0n, 'Playable reward tier not achieved')
        const fresh = mask & ~claimed,
            awarded = []
        for (let index = 0; index < dropIds.length; index++)
            if (fresh & (1n << BigInt(index + 1))) {
                const id = Number(dropIds[index])
                if (!emptyScoreRewards.has(row.id + ':' + id) || world.get('drop').some((entry) => entry.dropId === id))
                    awarded.push(id)
            }
        const rewards = awarded.length
            ? grantRewards(
                  tables,
                  c.state,
                  awarded.flatMap((id) => world.drops(id, c.randomInt)),
              )
            : []
        if (fresh) {
            finish.reward_info = Number(claimed | fresh)
            ;(c.state.playableScoreClaims ??= {})[row.id] = finish.reward_info
            sync(c)
        }
        return { play_id: row.id, rewards: { rewards }, drop_id: awarded }
    })
}
