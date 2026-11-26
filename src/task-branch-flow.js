import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
// Current MultiArrayConverter0602ec45 writes the condition index into each
// box.listStartNumber, its successors into box.saveLen, and row lengths into
// the outer saveLen array. Decode those explicit indexes, not row order.
export function taskBranchExit(graph, config, node, values, targets) {
    const data = config.__type_TaskConditonBranchNodeData
    ensure(config.nodeType === 34 && data, 'Not a branch condition node', ErrorCode.GameConfig)
    const conditions = list(data.conditionList),
        next = list(config.nextNodeIdList)
    ensure(conditions.length > 0, 'Branch conditions are unavailable', ErrorCode.GameConfig)
    ensure(
        conditions.every((condition, index) => condition.index === index),
        'Branch condition index mismatch',
        ErrorCode.GameConfig,
    )
    const mapping = data.branchNodeList
    let exits
    if (mapping) {
        const rows = mapping.multiArray ?? mapping.field_520101 ?? [],
            sizes = mapping.saveLen ?? mapping.field_520102 ?? []
        ensure(
            Array.isArray(rows) &&
                Array.isArray(sizes) &&
                sizes.length === conditions.length &&
                sizes.every((size) => Number.isSafeInteger(size) && size >= 0),
            'Invalid branch mapping dimensions',
            ErrorCode.GameConfig,
        )
        if (rows.length) {
            ensure(rows.length === conditions.length, 'Missing branch mapping row', ErrorCode.GameConfig)
            exits = new Array(conditions.length)
            for (const box of rows) {
                const index = box?.listStartNumber,
                    successors = box?.saveLen ?? []
                ensure(
                    Number.isSafeInteger(index) &&
                        index >= 0 &&
                        index < conditions.length &&
                        exits[index] === undefined,
                    'Invalid or duplicate branch mapping index',
                    ErrorCode.GameConfig,
                )
                ensure(
                    Array.isArray(successors) &&
                        successors.length === sizes[index] &&
                        successors.every((id) => Number.isSafeInteger(id) && id > 0 && graph.nodes.has(id)),
                    'Invalid or dangling branch mapping edge',
                    ErrorCode.GameConfig,
                )
                exits[index] = successors
            }
            // Neither empty exits nor multiple successors per condition have
            // a proven backend completion contract in the current client IL.
            ensure(
                exits.every((row) => row.length === 1),
                'Non-single-target branch mapping is not implemented',
                ErrorCode.FunctionClosed,
            )
            ensure(
                next.length === conditions.length && exits.every((row, index) => row[0] === next[index]),
                'Branch mapping disagrees with declared edges',
                ErrorCode.GameConfig,
            )
        } else {
            // Preserve the explicitly selected legacy flat graph shape only.
            ensure(
                sizes.every((size) => size === 0),
                'Missing nonempty branch mapping rows',
                ErrorCode.GameConfig,
            )
        }
    }
    if (!exits) {
        ensure(next.length === conditions.length, 'Branch exit mapping is unavailable', ErrorCode.FunctionClosed)
        exits = next.map((id) => [id])
    }
    ensure(
        next.every((id) => Number.isSafeInteger(id) && id > 0 && graph.nodes.has(id)),
        'Dangling branch exit',
        ErrorCode.GameConfig,
    )
    // A CondAfter ACK alone is insufficient: recheck the server-owned value.
    // Optional/nonmandatory flags do not manufacture a branch trigger.
    const indexes = conditions.flatMap((_, index) =>
        node.client_cond_after?.[index] === true && values[index] >= targets[index] ? [index] : [],
    )
    ensure(indexes.length > 0, 'No server-validated acknowledged branch condition', ErrorCode.InvalidArgument)
    const selected = [...new Set(indexes.map((index) => exits[index][0]))]
    ensure(selected.length === 1, 'Multiple distinct branch exits need verified arbitration', ErrorCode.FunctionClosed)
    return { indexes, next: selected }
}
