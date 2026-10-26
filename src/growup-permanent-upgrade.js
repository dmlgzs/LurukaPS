import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { spendCurrency } from './inventory.js'
import { preparePermanent, permanentModel, permanentPayload } from './growup-permanent.js'

export function upgradePermanent(c, r, catalog) {
    const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60])
    ensure(
        !row.guideTaskId || catalog.taskDone(c.state, row.guideTaskId),
        'Complete cultivation guide task first',
        ErrorCode.ActivityGrowUpExcultivationCondLimit,
    )
    const model = permanentModel(catalog.growup, row.systemId)
    ensure(
        Number.isInteger(r.type) && r.type > 0 && model.groups.has(r.type),
        'Invalid permanent cultivation type',
        ErrorCode.ActivityGrowUpInvalidParam,
    )
    let ledger = preparePermanent(catalog.growup, entry, row.systemId, c.id, c.now)
    const group = model.groups.get(r.type)
    ensure(
        ledger.unlocked.includes(group.assistant),
        'Permanent cultivation assistant is locked',
        ErrorCode.ActivityGrowUpExcultivationCondLimit,
    )
    const publish = () =>
        c.pushBefore('CSProtoSyncGrowupExcultivationData', {
            data: [{ ...permanentPayload(catalog.growup, entry, row.systemId, c.id).levels, activity_id: row.id }],
        })
    let key = c.requestKey
    if (key !== null && key !== undefined) {
        ensure(
            typeof key === 'string' && key.length > 0 && key.length <= 256,
            'Invalid permanent upgrade request identity',
            ErrorCode.GameConfig,
        )
        const old = ledger.upgrades[key]
        if (old) {
            ensure(
                old.type === r.type,
                'Permanent upgrade request identity changed',
                ErrorCode.ActivityGrowUpInvalidParam,
            )
            publish()
            return {}
        }
    } else {
        // A request without sequence is independent, never guessed from timing.
        let n = Object.keys(ledger.upgrades).length + 1
        while (ledger.upgrades[`unsequenced:${n}`]) n++
        key = `unsequenced:${n}`
    }
    const level = ledger.levels[group.type],
        current = group.rows.get(level),
        next = group.rows.get(level + 1)
    ensure(next, 'Permanent cultivation level is already maximal', ErrorCode.ActivityGrowUpInvalidParam)
    const [, currency, amount] = current.cost
    try {
        spendCurrency(c.state, currency, amount)
    } catch (error) {
        if (error.code === ErrorCode.ItemNotEnough)
            ensure(false, 'Insufficient permanent cultivation currency', ErrorCode.ActivityGrowUpExcultivationCostLimit)
        throw error
    }
    ledger = structuredClone(ledger)
    ledger.levels[group.type] = level + 1
    ledger.upgrades[key] = { version: 1, type: group.type, from: level, to: level + 1, currency, amount, time: c.now }
    entry.growupPermanent = ledger
    publish()
    return {}
}
