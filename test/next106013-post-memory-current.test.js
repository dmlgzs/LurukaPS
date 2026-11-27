import test from 'node:test'
import { runCurrentPostMemoryMilestone } from './next106013-post-memory-runner.js'

test('current106013 post-memory NPC and created-enemy nodes finish naturally and survive cold login', async () => {
    await runCurrentPostMemoryMilestone()
})
