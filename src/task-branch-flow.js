import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
// CBT3's raw branch metadata currently has no MultiList rows. Its observed
// pet-choice route pairs conditions with flat nextNodeIdList by index. Keep
// that compatibility inference bounded; it is not an invented decoder for
// multi-output branches or an assumption about simultaneous distinct exits.
export function taskBranchExit(graph, config, node, values, targets) {
    const data = config.__type_TaskConditonBranchNodeData
    ensure(config.nodeType === 34 && data, 'Not a branch condition node', ErrorCode.GameConfig)
    const conditions = list(data.conditionList),
        next = list(config.nextNodeIdList)
    ensure(
        conditions.length > 0 && next.length === conditions.length,
        'Branch exit mapping is unavailable',
        ErrorCode.FunctionClosed,
    )
    ensure(
        conditions.every((condition, index) => condition.index === index),
        'Branch condition index mismatch',
        ErrorCode.GameConfig,
    )
    const mapping = data.branchNodeList
    if (mapping) {
        const rows = list(mapping.multiArray ?? mapping.field_520101),
            sizes = list(mapping.saveLen ?? mapping.field_520102)
        ensure(
            !rows.length && sizes.length === conditions.length && sizes.every((size) => size === 0),
            'Multi-output branch mapping is not implemented',
            ErrorCode.FunctionClosed,
        )
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
    const selected = [...new Set(indexes.map((index) => next[index]))]
    ensure(selected.length === 1, 'Multiple distinct branch exits need verified arbitration', ErrorCode.FunctionClosed)
    return { indexes, next: selected }
}
