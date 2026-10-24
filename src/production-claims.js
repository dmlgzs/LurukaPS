import { hatchProductReceipt } from './hatch-effects.js'
import { ErrorCode } from './error-codes.js'
import { recordActiveProgress } from './daily-active.js'
import { ensure } from './handlers/common.js'
import { ensureHome } from './home.js'
import { productionTables } from './production-tables.js'
import { grantRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import { claimHatch, cancelHatch } from './hatching.js'
import { completed, refreshProduction, rescheduleJobs } from './production.js'

export function multiplyProductionRows(rows, count) {
    return rows.map((row) => {
        const itemnum = row.itemnum * count
        ensure(
            Number.isSafeInteger(itemnum) && itemnum > 0 && itemnum <= 0xffffffff,
            'Production quantity overflow',
            ErrorCode.GameConfig,
        )
        return { ...row, itemnum }
    })
}
export function ownedProduction(c, guid) {
    const h = ensureHome(c.tables, c.state),
        b = h.builds.find((b) => b.guid === guid)
    ensure(b?.locate, 'Production building is not owned/placed', ErrorCode.HomeNoBuild)
    ensure([1, 4].includes(b.status), 'Building is under construction', ErrorCode.HomeBuildInvalidStatus)
    return { h, b }
}
// Shared by individual finish/cancel and 6554. Inventory, partial batches,
// craft counters, queued work and preselected accessory results stay together.
export function claimProductionStock(c, request, { cancel = false, allowEmpty = false, includeHatch = true } = {}) {
    const tables = productionTables(c.tables),
        { h, b } = ownedProduction(c, request.guid)
    const jobs = h.productionJobs?.[b.guid] || []
    const ids = request.is_all ? jobs.map((job) => job.guid) : request.product_guids
    ensure(
        Array.isArray(ids) &&
            (allowEmpty || ids.length > 0) &&
            new Set(ids).size === ids.length &&
            ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff),
        'Invalid production selection',
        ErrorCode.InvalidArgument,
    )
    const selected = ids.map((id) => {
        const job = jobs.find((job) => job.guid === id)
        if (!job && !cancel) {
            const receipt = hatchProductReceipt(c.state, b.guid, id)
            if (receipt) {
                ensure(includeHatch, 'Aggregate claim excludes incubation', ErrorCode.FunctionClosed)
                return { kind: 'hatch-receipt', receipt }
            }
        }
        ensure(job, 'Product is not in this building', ErrorCode.InvalidArgument)
        ensure(includeHatch || job.kind !== 'hatch', 'Aggregate claim excludes incubation', ErrorCode.FunctionClosed)
        return job
    })
    const rewards = []
    let claimed = 0
    for (const job of selected) {
        if (job.kind === 'hatch-receipt') continue
        if (job.kind === 'hatch') {
            if (cancel) cancelHatch(c, job)
            else if (completed(job, c.now)) {
                rewards.push(claimHatch(c, job))
                claimed++
            }
            continue
        }
        const done = completed(job, c.now),
            available = done - job.claimed
        if (available > 0) {
            rewards.push(...grantRewards(tables, c.state, multiplyProductionRows(job.rewards, available)))
            job.claimed += available
            claimed += available
            h.craftCounts ??= {}
            h.craftCounts[job.productId] = (h.craftCounts[job.productId] || 0) + available
            recordActiveProgress(tables, c.state, 15011, available, c.now)
        }
        if (cancel) {
            const unfinished = job.count - done
            if (unfinished > 0)
                rewards.push(...grantRewards(tables, c.state, multiplyProductionRows(job.costs, unfinished)))
        }
    }
    ensure(
        cancel || claimed > 0 || allowEmpty || selected.every((job) => job.kind === 'hatch-receipt'),
        'No finished production available',
        ErrorCode.InvalidArgument,
    )
    if (claimed || cancel) {
        h.productionJobs[b.guid] = jobs.filter((job) => !(cancel && ids.includes(job.guid)) && job.claimed < job.count)
        if (cancel) rescheduleJobs(h.productionJobs[b.guid], c.now)
        refreshProduction(c.state, c.now)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
    }
    const accessory = selected.some((job) => job.kind === 'accessory'),
        operation = accessory
            ? cancel
                ? 'accessoryProductionCancel'
                : 'accessoryProductionFinish'
            : !cancel && rewards.length && selected.some((job) => !['hatch', 'hatch-receipt'].includes(job.kind))
              ? 'productionFinish'
              : undefined
    return {
        build: b,
        reward: {
            rewards,
            ...(operation ? { src: rewardSource(c.tables, operation) } : {}),
        },
    }
}
