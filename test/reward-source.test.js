import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { rewardSource } from '../src/reward-source.js'
test('verified source IDs distinguish whole task, task node, world interaction and stamina chest', () => {
    const tables = new Tables(configuration().tables)
    assert.equal(rewardSource(tables, 'taskComplete'), 26)
    assert.equal(rewardSource(tables, 'taskNodeComplete'), 88)
    assert.equal(rewardSource(tables, 'worldObjectInteract'), 84)
    assert.equal(rewardSource(tables, 'staminaChest'), 86)
})
test('source lookup needs no localization and falls back for absent rows or unknown operations', () => {
    const seen = []
    const tables = {
        find: (name, id) => {
            assert.equal(name, 'reason_itemnum_change')
            seen.push(id)
            return { id }
        },
        get: () => {
            throw Error('localization must not be accessed')
        },
    }
    assert.equal(rewardSource(tables, 'taskComplete'), 26)
    assert.equal(rewardSource(tables, 'taskNodeComplete'), 88)
    assert.deepEqual(seen, [26, 88])
    assert.equal(rewardSource({ find: () => undefined }, 'taskComplete'), undefined)
    assert.equal(rewardSource(tables, 'missing'), undefined)
    assert.equal(rewardSource(tables, '__proto__'), undefined)
    assert.equal(
        rewardSource(
            {
                find: () => {
                    throw Error('missing presentation table')
                },
            },
            'taskComplete',
        ),
        undefined,
    )
})

test('unknown source logs console and JSONL once; failed log output never blocks fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-reward-source-')),
        file = path.join(dir, 'warnings.jsonl'),
        logs = [],
        previous = console.warn,
        oldLog = process.env.LURUKAPS_REWARD_SOURCE_LOG
    console.warn = (line) => logs.push(line)
    process.env.LURUKAPS_REWARD_SOURCE_LOG = file
    try {
        const tables = { find: () => undefined }
        assert.equal(rewardSource(tables, 'diagnostic-unknown'), undefined)
        assert.equal(rewardSource(tables, 'diagnostic-unknown'), undefined)
        assert.equal(logs.length, 1)
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
        assert.equal(lines.length, 1)
        const record = JSON.parse(lines[0])
        assert.equal(record.reason, 'unknown_operation')
        assert.equal(record.operation, 'diagnostic-unknown')
        assert.equal(record.fallback, 'omit_src')
        assert.equal(record.source_id, null)
        // A file used as the parent directory forces an I/O failure.
        process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(file, 'cannot-write.jsonl')
        assert.equal(rewardSource(tables, 'diagnostic-log-failure'), undefined)
        assert.ok(logs.some((line) => line.includes('log-write-failed')))
    } finally {
        console.warn = previous
        if (oldLog === undefined) delete process.env.LURUKAPS_REWARD_SOURCE_LOG
        else process.env.LURUKAPS_REWARD_SOURCE_LOG = oldLog
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(dir).startsWith('lurukaps-reward-source-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
