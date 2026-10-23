import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { materialStoryPlan } from '../multiple-material-story.js'
const TIMELINE_VOTE = 1,
    TRANSFER_VOTE = 2,
    YES = 3
function boundStory(c, r) {
    ensure([TIMELINE_VOTE, TRANSFER_VOTE].includes(r.type), 'Unknown world voting type', ErrorCode.InvalidArgument)
    ensure(r.type === TIMELINE_VOTE, 'Transfer voting is not implemented', ErrorCode.FunctionClosed)
    ensure(
        Array.isArray(r.params) && r.params.length === 1,
        'Story vote requires one story identity',
        ErrorCode.InvalidArgument,
    )
    const text = String(r.params[0])
    ensure(
        /^\d+$/.test(text) && BigInt(text) > 0n && BigInt(text) <= 0xffffffffn,
        'Invalid story vote identity',
        ErrorCode.InvalidArgument,
    )
    const run = c.state.entrust?.run,
        s = run?.materialStory,
        storyId = Number(text)
    ensure(
        run && s && run.kind === 'material' && run.map_id === c.state.world.map_id,
        'No active local material story',
        ErrorCode.DungeonNotIn,
    )
    ensure(
        s.instance_id === run.instance_id && s.map_id === run.map_id && s.player_id === c.id,
        'Story vote instance mismatch',
        ErrorCode.InvalidLogic,
    )
    ensure(Array.isArray(s.participants), 'Saved story participant list is invalid', ErrorCode.GameConfig)
    ensure(
        s.participants.length === 1 && s.participants[0] === c.id,
        'Multiplayer story votes are not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(storyId === s.story_id, 'Vote does not belong to this playing story', ErrorCode.InvalidArgument)
    const plan = materialStoryPlan(c.tables, run)
    ensure(
        plan && plan.story_id === storyId && plan.boss_id === s.boss_id,
        'Material story vote scope changed',
        ErrorCode.InvalidLogic,
    )
    if (s.phase !== 'done')
        ensure(
            s.phase === 'playing' && run.status === 2 && s.connection_key === c.combatSessionId,
            'Story is not playing on this connection',
            ErrorCode.InvalidLogic,
        )
    return { run, story: s }
}
function publish(c, vote, story) {
    c.push('SCProtoWorldVotingSync', {
        id: vote.id,
        type: TIMELINE_VOTE,
        voting_val: String(YES),
        voting_num: 1,
        curr_voting: YES,
        start_sec: vote.start_millis,
        duration: vote.duration_millis,
    })
    c.push('SCProtoWorldVotingCloseSync', { id: vote.id })
    // This requests client StoryManager.Stop. The existing actual 11271 END
    // callback, not an invented op2 or this vote, activates the boss and timer.
    c.push('SCProtoPlayerStoryStop', { story_id: story.story_id })
}
export function registerMaterialStoryVoting(on) {
    on('WorldVotingStartReq', (c, r) => {
        const { run, story } = boundStory(c, r)
        let vote = story.skip_vote
        if (vote) {
            ensure(
                vote.status === 'passed' &&
                    Number.isInteger(vote.id) &&
                    vote.id > 0 &&
                    vote.id <= 0xffffffff &&
                    vote.instance_id === run.instance_id &&
                    vote.story_id === story.story_id &&
                    vote.player_id === c.id &&
                    vote.value === YES &&
                    /^\d+$/.test(vote.start_millis) &&
                    BigInt(vote.start_millis) > 0n &&
                    BigInt(vote.start_millis) <= 0xffffffffffffffffn &&
                    Number.isInteger(vote.duration_millis) &&
                    vote.duration_millis > 0 &&
                    vote.duration_millis <= 0xffffffff,
                'Saved story vote receipt is invalid',
                ErrorCode.GameConfig,
            )
            if (story.phase === 'done') return {}
            publish(c, vote, story)
            return {}
        }
        ensure(story.phase === 'playing', 'Story has already ended', ErrorCode.InvalidLogic)
        const seconds = Number(
                c.tables.get('game').find((x) => x.title === 'MULTIPLEVOTESKIPSTORYCOUNTDOWNTIME')?.value,
            ),
            duration = seconds * 1000
        ensure(
            Number.isInteger(seconds) && seconds > 0 && Number.isSafeInteger(duration) && duration <= 0xffffffff,
            'Story vote countdown configuration invalid',
            ErrorCode.GameConfig,
        )
        ensure(
            Number.isInteger(c.now) && c.now > 0 && c.now <= 0xffffffff,
            'Story vote clock cannot encode',
            ErrorCode.GameConfig,
        )
        const id = c.state.nextLocalStoryVoteId ?? 1
        ensure(
            Number.isInteger(id) && id > 0 && id <= 0xffffffff,
            'Local story vote identity exhausted',
            ErrorCode.GameConfig,
        )
        c.state.nextLocalStoryVoteId = id + 1
        // Explicit local policy: the sole player pressed Skip, and the CBT3
        // receiver does not open a confirmation page when team count <=1.
        // Do not manufacture another participant or pretend this is multiplayer.
        vote = story.skip_vote = {
            id,
            instance_id: run.instance_id,
            story_id: story.story_id,
            player_id: c.id,
            status: 'passed',
            value: YES,
            start_millis: (BigInt(c.now) * 1000n).toString(),
            duration_millis: duration,
        }
        publish(c, vote, story)
        return {}
    })
}
