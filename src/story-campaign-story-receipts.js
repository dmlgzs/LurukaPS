import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// LOCAL compatibility from current1.0 data and the6060 completion consumer.
// Only bare2506/storyId/0/1, single mapped scene and autoExit0 are supported.
// TODO: the official fourth-parameter mapper and other forms are not recovered.
// No global watched history is imported into an instance receipt.
export const storyCampaignStoryReceiptPolicy = Object.freeze({
    version: 1,
    local: true,
    officiallyVerified: false,
    shape: '2506#storyId#0#1',
    scope: 'server-active-campaign-instance',
    skippedCompletionAccepted: true,
    autoExit: 0,
})
const positive = (value) => Number.isSafeInteger(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const sameScope = (left, right) =>
    object(left) &&
    ['player_id', 'instance_id', 'dungeon_id', 'scene_id', 'start_time'].every((key) => left[key] === right[key])

export function storyCampaignStoryRule(tables, dungeonId) {
    const dungeon = tables.find('dungeon', dungeonId)
    ensure(dungeon, 'Story campaign dungeon configuration is missing', ErrorCode.GameConfig)
    const parts = String(dungeon.victoryCondition ?? '')
        .split('#')
        .map(Number)
    if (parts[0] !== 2506) return null
    ensure(
        parts.length === 4 && positive(parts[1]) && parts[2] === 0 && parts[3] === 1,
        'Story campaign victory shape is unsupported',
        ErrorCode.FunctionClosed,
    )
    const story = tables.find('story', parts[1]),
        mapping = tables.get('dungeon_task').find((row) => row.dungeonId === dungeonId)
    ensure(story, 'Story campaign victory story configuration is missing', ErrorCode.GameConfig)
    ensure(
        Number.isInteger(story.storyType) && story.storyType >= 0 && story.storyType <= 4,
        'Story campaign victory story type is damaged',
        ErrorCode.GameConfig,
    )
    ensure(story.storyType === 0, 'Story campaign victory story type is unsupported', ErrorCode.FunctionClosed)
    ensure(mapping, 'Story campaign task declaration is missing', ErrorCode.GameConfig)
    ensure([0, 1].includes(mapping.autoExit), 'Story campaign auto-exit configuration is damaged', ErrorCode.GameConfig)
    ensure(mapping.autoExit === 0, 'Story campaign automatic story exit is unsupported', ErrorCode.FunctionClosed)
    const taskIds = String(mapping.taskIds).split('|').map(Number),
        points = String(mapping.taskTeleportIds)
            .split('|')
            .map(Number)
            .map((id) => tables.find('world_borthpos', id))
    ensure(
        taskIds.length > 0 &&
            taskIds.every(positive) &&
            new Set(taskIds).size === taskIds.length &&
            points.length === taskIds.length &&
            points.every((row) => positive(row?.cityId)),
        'Story campaign task mapping is damaged',
        ErrorCode.GameConfig,
    )
    const scenes = [...new Set(points.map((row) => row.cityId))]
    ensure(scenes.length === 1, 'Story campaign multi-scene story receipt is unsupported', ErrorCode.FunctionClosed)
    return {
        dungeonId,
        storyId: parts[1],
        storyType: 0,
        tag: 0,
        taskIds,
        sceneId: scenes[0],
        condition: dungeon.victoryCondition,
    }
}

function scope(state, run, rule) {
    ensure(
        positive(run.instance_id) && positive(run.start_time) && positive(state.player?.basic_info?.id),
        'Story campaign instance scope is unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(run.task_ids) &&
            same(run.task_ids, rule.taskIds) &&
            Array.isArray(run.scenes) &&
            same(run.scenes, [rule.sceneId]),
        'Story campaign instance declaration changed',
        ErrorCode.GameConfig,
    )
    return {
        player_id: state.player.basic_info.id,
        instance_id: run.instance_id,
        dungeon_id: rule.dungeonId,
        scene_id: rule.sceneId,
        start_time: run.start_time,
    }
}
function checkReceipt(receipt, expected, rule) {
    ensure(
        object(receipt) &&
            receipt.version === 1 &&
            receipt.policy === 'local-current-2506-0-1' &&
            sameScope(receipt.scope, expected) &&
            receipt.condition === rule.condition &&
            receipt.story_id === rule.storyId &&
            receipt.story_type === rule.storyType &&
            receipt.tag === rule.tag &&
            receipt.completed === true &&
            typeof receipt.is_skip === 'boolean' &&
            positive(receipt.received_at),
        'Story campaign completion receipt is damaged or belongs to another instance',
        ErrorCode.GameConfig,
    )
    return receipt
}

export function recordStoryCampaignStoryReceipt(c, request) {
    const run = c.state.storyCampaign
    if (!run || run.status !== 2 || run.map_id !== c.state.world.map_id) return false
    const rule = storyCampaignStoryRule(c.tables, run.dungeon_id)
    if (
        !rule ||
        run.map_id !== rule.sceneId ||
        request.story_id !== rule.storyId ||
        (request.story_type ?? 0) !== rule.storyType ||
        (request.tag ?? 0) !== rule.tag
    )
        return false
    const expected = scope(c.state, run, rule)
    if (run.story_victory_receipt !== undefined) {
        checkReceipt(run.story_victory_receipt, expected, rule)
        return false
    }
    ensure(
        typeof (request.is_skip ?? false) === 'boolean' && positive(c.now),
        'Invalid story campaign completion receipt',
        ErrorCode.InvalidArgument,
    )
    run.story_victory_receipt = {
        version: 1,
        policy: 'local-current-2506-0-1',
        scope: expected,
        condition: rule.condition,
        story_id: rule.storyId,
        story_type: rule.storyType,
        tag: rule.tag,
        completed: true,
        is_skip: request.is_skip ?? false,
        received_at: c.now,
    }
    return true
}

export function storyCampaignStorySatisfied(tables, state) {
    const run = state.storyCampaign
    if (!run || ![2, 3].includes(run.status) || run.map_id !== state.world.map_id) return false
    const rule = storyCampaignStoryRule(tables, run.dungeon_id)
    if (!rule || run.map_id !== rule.sceneId) return false
    const expected = scope(state, run, rule)
    if (run.story_victory_receipt === undefined) return false
    checkReceipt(run.story_victory_receipt, expected, rule)
    const records = state.taskRecords ?? []
    ensure(Array.isArray(records), 'Story campaign task completion records are damaged', ErrorCode.GameConfig)
    return rule.taskIds.every((id) => {
        const matches = records.filter((row) => row.task_id === id)
        ensure(
            matches.length <= 1 && matches.every((row) => Number.isSafeInteger(row.count) && row.count >= 0),
            'Story campaign task completion record is damaged',
            ErrorCode.GameConfig,
        )
        return matches.length === 1 && matches[0].count > 0
    })
}

export function storyCampaignStoryProof(tables, state) {
    ensure(
        storyCampaignStorySatisfied(tables, state),
        'Story campaign completion proof is not earned',
        ErrorCode.InvalidLogic,
    )
    const rule = storyCampaignStoryRule(tables, state.storyCampaign.dungeon_id)
    return {
        version: 1,
        kind: 2506,
        task_ids: [...rule.taskIds],
        receipt: structuredClone(state.storyCampaign.story_victory_receipt),
    }
}

export function verifiedStoryCampaignStoryClear(tables, state, dungeonId) {
    const clear = state.storyCampaignClears?.[dungeonId],
        rule = storyCampaignStoryRule(tables, dungeonId)
    if (!clear || !positive(clear.count) || !rule || clear.story_proof === undefined) return false
    const proof = clear.story_proof
    ensure(
        object(proof) && proof.version === 1 && proof.kind === 2506 && same(proof.task_ids, rule.taskIds),
        'Saved story campaign proof is damaged',
        ErrorCode.GameConfig,
    )
    const expected = proof.receipt?.scope
    ensure(
        object(expected) &&
            expected.player_id === state.player?.basic_info?.id &&
            positive(expected.instance_id) &&
            expected.dungeon_id === dungeonId &&
            expected.scene_id === rule.sceneId &&
            positive(expected.start_time),
        'Saved story campaign proof scope is damaged',
        ErrorCode.GameConfig,
    )
    checkReceipt(proof.receipt, expected, rule)
    return true
}
