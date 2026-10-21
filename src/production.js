export function completed(job, now) {
    return Math.min(job.count, Math.max(0, Math.floor((now - job.start) / job.seconds)))
}
function hatchPhase(job, now) {
    return now < job.start ? 1 : completed(job, now) ? 3 : 2
}
export function productionDue(state, now) {
    return Object.values(state.home?.productionJobs || {}).some((jobs) =>
        jobs.some(
            (j) =>
                completed(j, now) !== (j.reportedDone || 0) ||
                (j.kind === 'hatch' && hatchPhase(j, now) !== j.reportedPhase),
        ),
    )
}
export function refreshProduction(state, now) {
    if (!state.home) return false
    let changed = false
    for (const build of state.home.builds) {
        const jobs = state.home.productionJobs?.[build.guid]
        if (!jobs) continue
        const wire = jobs.map((j) => {
            const done = completed(j, now)
            j.reportedDone = done
            return {
                product_id: j.productId,
                product_guid: j.guid,
                total_count: j.count - done,
                finish_count: done - j.claimed,
                start_time: j.start + done * j.seconds,
                finish_time: j.start + Math.min(j.count, done + 1) * j.seconds,
                total_finish_time: j.start + j.count * j.seconds,
            }
        })
        const status = jobs.some((j) => completed(j, now) < j.count) ? 4 : 1
        const workerIndex =
            state.pets?.findIndex((pet) => pet.guid === build.station_pet_guid && pet.work_build === build.guid) ?? -1
        const worker = state.pets?.[workerIndex]
        if (worker && [1, 2].includes(worker.work_status) && worker.work_status !== (status === 4 ? 2 : 1)) {
            // Some deferred requests share the pet collection. Copy only this
            // changed worker so a later rejected request cannot leak its status.
            state.pets = [...state.pets]
            state.pets[workerIndex] = { ...worker, work_status: status === 4 ? 2 : 1 }
            state.petRevision = (state.petRevision || 0) + 1
            changed = true
        }
        if (JSON.stringify(build.product || []) !== JSON.stringify(wire) || build.status !== status) {
            build.product = wire
            build.status = status
            changed = true
        }
        const eggs = jobs.filter((j) => j.kind === 'hatch')
        if (eggs.length || build.hatch) {
            const infos = eggs.map((j, i) => {
                const phase = hatchPhase(j, now)
                j.reportedPhase = phase
                const egg = (state.petEggs || []).find((e) => e.guid === j.eggGuid)
                if (egg && egg.hatch_state !== phase) {
                    egg.hatch_state = phase
                    state.eggRevision = (state.eggRevision || 0) + 1
                }
                return {
                    egg_guid: j.eggGuid,
                    start_time: phase === 1 ? 0 : j.start,
                    finish_time: j.start + j.seconds,
                    state: phase,
                    slot: i + 1,
                }
            })
            const hatch = { hatch_infos: infos },
                specials = eggs.map((j) => ({ product_guid: j.guid, extra_guid: j.eggGuid }))
            if (
                JSON.stringify(build.hatch) !== JSON.stringify(hatch) ||
                JSON.stringify(build.specials) !== JSON.stringify(specials)
            ) {
                build.hatch = hatch
                build.specials = specials
                changed = true
            }
        }
        const accessories = jobs.filter((job) => job.kind === 'accessory')
        if (accessories.length || build.specials?.some((info) => Object.hasOwn(info, 'designate_item_id'))) {
            const specials = [
                ...eggs.map((job) => ({ product_guid: job.guid, extra_guid: job.eggGuid })),
                ...accessories.map((job) => ({
                    product_guid: job.guid,
                    designate_item_id: job.designatedItemId ?? 0,
                    designate_item_type: job.designatedItemId ? 33 : 0,
                    designate_cost: (job.designateCosts ?? []).map((item) => ({
                        itemtype: item.itemtype,
                        itemid: item.itemid,
                        itemnum: item.itemnum,
                    })),
                    items: [],
                })),
            ]
            if (JSON.stringify(build.specials ?? []) !== JSON.stringify(specials)) {
                build.specials = specials
                changed = true
            }
        }
    }
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return changed
}
export function rescheduleJobs(jobs, now) {
    let end = now
    for (const job of jobs) {
        if (job.start > now) job.start = Math.max(now, end)
        end = Math.max(end, job.start + job.count * job.seconds)
    }
}
