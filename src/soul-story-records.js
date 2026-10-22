import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function soulStoryIds(state) {
    const ids = [...(state.soulEssenceStoryRecords ?? []), ...(state.player.soulessence_infos.cfg_story_id ?? [])]
    ensure(
        ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff),
        'Invalid saved soul story records',
        ErrorCode.GameConfig,
    )
    return [...new Set(ids)].sort((a, b) => a - b)
}
export function playerWithSoulStoryRecords(state) {
    return {
        ...state.player,
        soulessence_infos: { ...state.player.soulessence_infos, cfg_story_id: soulStoryIds(state) },
    }
}
export function recordSoulStory(c, r) {
    ensure(
        Number.isSafeInteger(r.cfg_id) && r.cfg_id > 0,
        'Invalid soul essence configuration identity',
        ErrorCode.InvalidArgument,
    )
    const config = c.tables.find('soulessence', r.cfg_id)
    ensure(config, 'Soul essence configuration missing', ErrorCode.SoulEssenceConfNotExist)
    ensure(
        Number.isSafeInteger(config.story) && config.story > 0 && c.tables.find('story', config.story),
        'Soul essence story configuration missing',
        ErrorCode.StoryConfNotExist,
    )
    // All current 2451868 story-bearing rows have an empty condition list.
    // Future unlock selectors need their real condition evaluator, not a bypass.
    ensure(
        !config.storyLock || (Array.isArray(config.storyLock) && !config.storyLock.length),
        'Soul story unlock conditions are not implemented',
        ErrorCode.FunctionClosed,
    )
    const records = soulStoryIds(c.state)
    if (!records.includes(r.cfg_id)) {
        ensure(
            c.state.player.soulessence_infos.soulessences.some((item) => item.id === r.cfg_id),
            'Soul essence is not owned',
            ErrorCode.SoulEssenceNotExist,
        )
        records.push(r.cfg_id)
        records.sort((a, b) => a - b)
        c.state.soulEssenceStoryRecords = records
    }
    // The click sends this request BEFORE PlayStory. It is neither story
    // completion nor a task reward. The ACK callback updates the local cache;
    // keep the ledger out of repeated equipment deltas, whose receiver appends.
    return { cfg_id: r.cfg_id }
}
