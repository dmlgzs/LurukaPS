import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentWingsMilestone } from './next106014-runner.js'
import { runCurrentCommonStoryDungeon } from './current-common-dungeon-story-model.js'
import { taskSnapshot } from '../src/tasks.js'

test('normal106014 uses actual continuous-story callback ordering and two scenes without synthetic9507', async () => {
    const events = []
    const directory =
        process.env.STORY_DUNGEON_CALLBACK_ARTIFACTS ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-story-callback-'))
    fs.mkdirSync(directory, { recursive: true })
    try {
        const result = await runCurrentWingsMilestone({
            outputDirectory: directory,
            dungeonLifecycle: (context) => runCurrentCommonStoryDungeon(context, events),
            afterChapter({ f }) {
                const state = f.state()
                fs.writeFileSync(
                    path.join(directory, 'next-main.json'),
                    JSON.stringify(
                        {
                            requests: f.requestCount(),
                            level: state.player.basic_info.lv,
                            exp: state.player.basic_info.exp,
                            nextMain: taskSnapshot(f.tables, state).next_main_id,
                            active: state.tasks.map((task) => ({
                                id: task.task_id,
                                nodes: task.nodes.map((node) => node.node_id),
                            })),
                            world: state.world,
                        },
                        null,
                        2,
                    ) + '\n',
                )
            },
        })
        assert.equal(result.final.waves, 3)
        assert.equal(result.rejected.length, 0)
        assert.deepEqual(
            events.filter((row) => row.kind === 'watch6060').map((row) => row.id),
            [1011001, 101101, 101102, 10110202, 101104, 101105, 101103, 101104, 101105],
        )
        for (let index = 0; index < events.length; index++) {
            const row = events[index]
            if (row.kind !== 'watch6060') continue
            const record = row.type === 2 ? events[index - 1] : events[index + 1]
            assert.equal(record.kind, 'record1004')
            assert.equal(record.id, row.id)
            assert.equal(record.map, row.map)
        }
        assert.deepEqual(
            events.filter((row) => row.kind.startsWith('transmit')).map((row) => row.kind),
            ['transmit9506', 'transmit9503'],
        )
        const proof = JSON.parse(fs.readFileSync(path.join(directory, 'wings106014.json'), 'utf8'))
        assert.equal(proof.trace.filter((row) => row.id === 9507).length, 0)
        assert.equal(proof.trace.filter((row) => row.error).length, 0)
        for (const id of [9506, 9503]) {
            const at = proof.trace.findIndex((row) => row.id === id)
            assert(at >= 2)
            assert.equal(proof.trace[at - 2].id, 6060)
            assert.equal(proof.trace[at - 2].request.story_id, 101105)
            assert.equal(proof.trace[at - 1].id, 9904)
            assert.deepEqual(proof.trace[at - 1].request, { key: 1004, args: [101105, 1] })
        }
    } finally {
        fs.writeFileSync(path.join(directory, 'callback-events.json'), JSON.stringify(events, null, 2) + '\n')
    }
})
