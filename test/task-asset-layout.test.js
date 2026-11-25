import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { base, configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { TaskGraphs } from '../src/tasks.js'
import { ErrorCode } from '../src/error-codes.js'

const graphData = (id) => ({
    taskId: id,
    endNodeId: 2,
    nodes: [{ __type_TaskBaseNodeData: { id: 1, nodeType: 10 } }, { __type_TaskBaseNodeData: { id: 2, nodeType: 90 } }],
})
test('current exported ast_ task assets load from the current 1.0 directory', () => {
    const tables = new Tables(configuration().tables)
    for (const id of [106001, 106002]) {
        const graph = new TaskGraphs(tables).get(id)
        assert(graph.nodes.has(graph.start))
        assert(graph.nodes.has(graph.end))
        assert.equal(graph.config.id, id)
    }
})

test('legacy names remain directory-local and a malformed current asset cannot fall back', () => {
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    const root = fs.mkdtempSync(path.join(base, 'data/task-asset-layout-'))
    const tables = { find: () => ({ id: 123 }), get: () => [] }
    try {
        fs.writeFileSync(path.join(root, 'task_client_123.json'), JSON.stringify(graphData(123)))
        assert.equal(new TaskGraphs(tables, root).get(123).start, 1)
        fs.writeFileSync(path.join(root, 'ast_task_client_123.json'), '{')
        assert.throws(() => new TaskGraphs(tables, root).get(123), SyntaxError)
        fs.writeFileSync(path.join(root, 'ast_task_client_123.json'), JSON.stringify(graphData(456)))
        assert.throws(
            () => new TaskGraphs(tables, root).get(123),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () => new TaskGraphs(tables, root).get(999),
            (error) => error.code === ErrorCode.TaskConfFail,
        )
    } finally {
        for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file))
        fs.rmdirSync(root)
    }
})
