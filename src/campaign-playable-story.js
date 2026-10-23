import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Opt-in hook for the new local campaign mode. It never creates victory or
// changes world position. Only its configured current-scene stories are consumed.
export function recordLocalCampaignStory(c, r) {
    const run = c.state.storyCampaign,
        a = r.args ?? []
    if (
        !run?.local_playable_condition ||
        run.map_id !== c.state.world.map_id ||
        r.key !== 1004 ||
        a.length !== 2 ||
        a[1] !== 1
    )
        return false
    if (a[0] !== run.opening_story && a[0] !== run.ending_story) return false
    ensure(
        Number.isSafeInteger(run.instance_id) && run.instance_id > 0,
        'Campaign story instance is missing or damaged',
        ErrorCode.InvalidLogic,
    )
    if (a[0] === run.ending_story) {
        ensure(
            run.status === 3 && run.completed_scenes?.includes(run.map_id),
            'Campaign ending story is not ready',
            ErrorCode.InvalidLogic,
        )
        run.ending_story_complete = true
        return true
    }
    ensure(
        run.status === 2 || (run.status === 3 && run.opening_story_complete),
        'Campaign opening story is not active',
        ErrorCode.InvalidLogic,
    )
    if (run.opening_story_complete) return true
    run.opening_story_complete = true
    // Common graph69 ->70 explicitly deletes deleteItemTag1 before target slot1.
    const objects = []
    for (const row of c.tables.get('worldmap_' + run.map_id))
        if (String(row.commonTag) === String(run.opening_delete_tag)) {
            const record = c.state.worldObjects?.[run.map_id + ':' + row.id]
            if (record) {
                record.active = false
                const { claims, ...wire } = record
                objects.push(wire)
            }
        }
    if (objects.length)
        c.pushBefore('CSProtoWorldMapSync', {
            cmd: 47,
            map_id: run.map_id,
            map_info: { creator_id: c.id, map_id: run.map_id, objs: objects },
        })
    return true
}
