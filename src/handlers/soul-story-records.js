import { recordSoulStory } from '../soul-story-records.js'
export function registerSoulStoryRecords(on) {
    on('LiZiStoryRecored', recordSoulStory)
}
