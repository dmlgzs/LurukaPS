import assert from 'node:assert/strict'

const records = new WeakMap()
const profiles = new Map([
    [101029, { tag: 0, clicks: 0, terminal: 12 }],
    [101030, { tag: 0, clicks: 0, terminal: 11 }],
    [
        101042,
        {
            tag: 0,
            clicks: 2,
            terminal: 31,
            choices: [
                [10104215, 0],
                [10104224, 0],
            ],
        },
    ],
    [
        101043,
        {
            tag: 0,
            clicks: 2,
            terminal: 40,
            choices: [
                [10104305, 0],
                [10104325, 0],
            ],
        },
    ],
])
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])
export const conditionAfterPhaseTrace = (f) => structuredClone(records.get(f) ?? [])

// Current type2 local action queue. This exercises one nondeferred network
// ordering: preceding watch reports, then final local completion callback's
// condition ACK, then the final watch report. It is not every Native schedule.
export function runCurrentConditionAfterQueue(f, first, taskId, node, requiredIndexes) {
    const slots = list(node.__type_TaskConditionNodeData?.taskCondAfterActionList)
    const queue = []
    for (const index of requiredIndexes)
        for (const slot of slots) {
            if (slot.coditionIndex !== index) continue
            for (const union of list(slot.conditionAfterAction)) {
                const base = union.__type_TaskActionBaseData
                assert(base)
                const kinds = Object.keys(base).filter((key) => key.startsWith('__type_'))
                assert.equal(kinds.length, 1)
                queue.push({ index, kind: kinds[0], data: base[kinds[0]] })
            }
        }
    if (!queue.length) return false
    let events = records.get(f)
    if (!events) records.set(f, (events = []))
    const event = (data) => events.push({ taskId, nodeId: node.id, ...data })
    const reportStory = (entry) => {
        const profile = profiles.get(entry.data.storyId)
        assert(profile, 'Unknown current condition-after story source')
        assert.equal(f.tables.find('story', entry.data.storyId).storyType, 0)
        const request = {
            story_id: entry.data.storyId,
            story_type: 0,
            tag: profile.tag,
            param: profile.clicks,
            is_skip: false,
        }
        first.call('SetStoryId', request)
        event({ phase: 'actual6060-watch-accepted', index: entry.index, request, profile })
    }
    for (const [position, entry] of queue.entries()) {
        event({ phase: 'local-start', index: entry.index, kind: entry.kind, data: entry.data })
        assert(
            ['__type_TaskOpenStoryData', '__type_TaskBlackData'].includes(entry.kind),
            'Unknown required conditional local action',
        )
        if (entry.kind === '__type_TaskOpenStoryData') {
            assert.equal(entry.data.isPlayEndCb, false)
            assert(profiles.has(entry.data.storyId))
        }
        event({ phase: 'local-complete', index: entry.index, kind: entry.kind, data: entry.data })
        if (position < queue.length - 1 && entry.kind === '__type_TaskOpenStoryData') reportStory(entry)
    }
    const request = { task_id: taskId, node_id: node.id, indexes: requiredIndexes }
    const packets = first.call('TaskClientCondAfter', request)
    assert(packets.some((packet) => packet.id === 9863))
    event({ phase: 'actual9863-ACK-accepted', request })
    const last = queue.at(-1)
    if (last.kind === '__type_TaskOpenStoryData') reportStory(last)
    return true
}
