import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { spend } from './inventory.js'
import { syncCurrencyMirrors } from './currency.js'
import { taskItemCount, changeTaskItem } from './task-items.js'
import { instanceTaskTypes, taskInstanceGuid, taskResourcePlan } from './task-resource-consumption.js'
export function deliveryKey(state, taskId, nodeId, index) {
    return `${taskId}:${state.taskEpochs?.[taskId] || 0}:${nodeId}:${index}`
}
function instanceReceipt(items) {
    if (!items?.length || items.some((item) => !instanceTaskTypes.has(item.item_type))) return null
    return JSON.stringify(
        items
            .map((item) => [item.item_type, item.item_id, item.item_count, taskInstanceGuid(item.item_guid)])
            .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3].localeCompare(b[3])),
    )
}
export function instanceDeliveryReplay(state, context, items) {
    const receipt = instanceReceipt(items)
    return (
        !!receipt &&
        !!state.taskInstanceDeliveries?.[deliveryKey(state, context.taskId, context.nodeId, context.index)]?.includes(
            receipt,
        )
    )
}
export function deliveryRequirements(condition) {
    const base = condition.__type_TaskConditionBaseData ?? {}
    if ([2513, 2514].includes(condition.conditionId)) {
        const data =
            condition.conditionId === 2513 ? base.__type_TaskCondSubTypeItemData : base.__type_TaskCondSubChooseItemData
        ensure(
            data && Number.isInteger(data.itemCount) && data.itemCount > 0,
            'Invalid selection requirement',
            ErrorCode.GameConfig,
        )
        ensure(data.itemBigType === 3, 'Unsupported selected task item category', ErrorCode.InvalidProtoID)
        const allowedIds = Array.isArray(data.itemIds) ? data.itemIds : data.itemIds ? [data.itemIds] : []
        if (condition.conditionId === 2514)
            ensure(
                allowedIds.length > 0 && allowedIds.every((id) => Number.isInteger(id) && id > 0),
                'Invalid selected task item list',
                ErrorCode.GameConfig,
            )
        else
            ensure(
                Number.isInteger(data.itemType) && data.itemType > 0,
                'Invalid task item subtype',
                ErrorCode.GameConfig,
            )
        return { data, total: data.itemCount, allowedIds, mode: condition.conditionId === 2513 ? 'category' : 'choice' }
    }
    const data = base.__type_TaskCondSubItemData
    ensure(condition.conditionId === 2501 && data, 'Not an item submission condition')
    const rows = Array.isArray(data.itemDatas) ? data.itemDatas : data.itemDatas ? [data.itemDatas] : []
    ensure(rows.length > 0, 'Empty item requirement', ErrorCode.GameConfig)
    const requirements = new Map()
    for (const row of rows) {
        ensure(
            Number.isInteger(row.itemId) && row.itemId > 0 && Number.isInteger(row.count) && row.count > 0,
            'Invalid task item requirement',
            ErrorCode.GameConfig,
        )
        const key = `${data.itemBigType}:${row.itemId}`
        requirements.set(key, (requirements.get(key) || 0) + row.count)
    }
    return { data, requirements, mode: 'exact' }
}
export function deliveryComplete(state, condition, context) {
    if (!context) return false
    const spec = deliveryRequirements(condition),
        record = state.taskDeliveries?.[deliveryKey(state, context.taskId, context.nodeId, context.index)] || {}
    if (spec.mode === 'exact') return [...spec.requirements].every(([key, n]) => (record[key] || 0) >= n)
    return Object.values(record).reduce((sum, n) => sum + n, 0) >= spec.total
}
export function submitTaskItems(c, condition, context, items) {
    const spec = deliveryRequirements(condition),
        { data, requirements } = spec
    ensure(
        [3, 5, 10, 13, 14, 15, 20].includes(data.itemBigType),
        'This task item category is not implemented',
        ErrorCode.FunctionClosed,
    )
    const mapId = data.mapId || condition.__type_TaskConditionBaseData?.mapData?.sceneId
    ensure(!mapId || c.state.world.map_id === mapId, 'Task submission is in a different map')
    ensure(Array.isArray(items) && items.length <= 100, 'Invalid submission list')
    // Fixed-item9854 requests omit items in CBT3. Only this mode can resolve
    // its exact remaining costs from the graph; choice/category deliveries
    // still require the client's explicit selection.
    if (!items.length && spec.mode === 'exact') {
        const record =
            c.state.taskDeliveries?.[deliveryKey(c.state, context.taskId, context.nodeId, context.index)] ?? {}
        items = [...requirements].flatMap(([key, count]) => {
            const remaining = count - (record[key] ?? 0)
            if (remaining <= 0) return []
            const [item_type, item_id] = key.split(':').map(Number)
            return [{ item_type, item_id, item_count: remaining }]
        })
        if (!items.length) return
        ensure(
            !instanceTaskTypes.has(data.itemBigType),
            'Task instances require explicit selection',
            ErrorCode.TaskSubmitItemChoseError,
        )
    }
    ensure(items.length > 0 && items.length <= 100, 'Invalid submission list')
    const amounts = new Map()
    for (const item of items) {
        ensure(
            item.item_type === data.itemBigType &&
                (instanceTaskTypes.has(data.itemBigType) || !item.item_guid || item.item_guid === '0'),
            'Wrong task item category or instance',
        )
        ensure(Number.isInteger(item.item_count) && item.item_count > 0, 'Invalid task item count')
        const key = `${item.item_type}:${item.item_id}`
        if (spec.mode === 'exact') ensure(requirements.has(key), 'Item not requested by task')
        else {
            const config = c.tables.find('common_item', item.item_id)
            ensure(config, 'Unknown submitted item')
            ensure(
                spec.mode === 'choice' ? spec.allowedIds.includes(item.item_id) : config.type === data.itemType,
                'Item not requested by task',
            )
            if (spec.mode === 'choice' && data.itemType)
                ensure(config.type === data.itemType, 'Wrong selected item subtype')
        }
        const n = (amounts.get(key) || 0) + item.item_count
        ensure(Number.isSafeInteger(n) && n <= 0xffffffff, 'Task item quantity overflow')
        amounts.set(key, n)
    }
    c.state.taskDeliveries ??= {}
    const key = deliveryKey(c.state, context.taskId, context.nodeId, context.index),
        record = c.state.taskDeliveries[key] || {}
    if (spec.mode === 'exact') {
        for (const [id, n] of amounts)
            ensure((record[id] || 0) + n <= requirements.get(id), 'Task item requirement already fulfilled')
    } else
        ensure(
            Object.values(record).reduce((sum, n) => sum + n, 0) +
                [...amounts.values()].reduce((sum, n) => sum + n, 0) <=
                spec.total,
            'Task item requirement already fulfilled',
        )
    const consumeResources = taskResourcePlan(c, items)
    const costs = new Map(),
        wallet = [],
        taskCosts = []
    for (const [key, n] of amounts) {
        const [type, id] = key.split(':').map(Number)
        if (type === 3) costs.set(id, n)
        else if (type === 20) taskCosts.push([id, n])
        else if (type === 10) wallet.push([id, n])
    }
    for (const [id, n] of taskCosts) ensure(taskItemCount(c.state, id) >= n, 'Insufficient task items')
    for (const [id, n] of wallet) {
        const value =
            id === 1
                ? c.state.player.basic_info.diamond
                : id === 2
                  ? c.state.player.basic_info.gold
                  : BigInt(c.state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val || 0)
        ensure(BigInt(value) >= BigInt(n), 'Insufficient task currency')
    }
    const changed = costs.size ? spend(c.state, costs, 0, c.now) : []
    for (const [id, n] of taskCosts) changeTaskItem(c.tables, c.state, id, -n)
    for (const [id, n] of wallet) {
        if (id === 1) c.state.player.basic_info.diamond -= n
        else if (id === 2) c.state.player.basic_info.gold -= n
        else {
            const a = c.state.player.attr_infos.attrs.find((a) => a.attr_id === id)
            a.attr_val = String(BigInt(a.attr_val) - BigInt(n))
        }
    }
    syncCurrencyMirrors(c.state.player)
    consumeResources()
    for (const [id, n] of amounts) record[id] = (record[id] || 0) + n
    c.state.taskDeliveries[key] = record
    const receipt = instanceReceipt(items)
    if (receipt) {
        c.state.taskInstanceDeliveries ??= {}
        ;(c.state.taskInstanceDeliveries[key] ??= []).push(receipt)
    }
    c.push('CSProtoSyncPlayerData', {
        basic_info: c.state.player.basic_info,
        attr_infos: c.state.player.attr_infos,
        sbag_infos: { items: changed },
    })
}
