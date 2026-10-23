import { finishMaterialStory } from '../multiple-material-story.js'
import { syncEntrustStage } from './entrust.js'
export function registerMaterialStory(on) {
    on('PlayerStoryStop', (c, r) => {
        const fresh = finishMaterialStory(c, r)
        // The current receiver uses story_id only. Do not invent stop_ops ordering
        // or represent an unimplemented multiplayer voting barrier as completed.
        c.push('SCProtoPlayerStoryStop', { story_id: r.story_id })
        if (fresh) syncEntrustStage(c)
    })
}
