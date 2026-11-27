import assert from 'node:assert/strict'

// Qualified successful local observations for3217420 TaskTraceModule and
// playable62024/BP362011/AI103029. No Unity AI,NavMesh,occlusion or animation
// execution. Alert/range callbacks and ready arrivals are explicit inputs.
export function currentTaskTraceInput(tables) {
    const playable = tables.find('playable', 62024)
    assert(playable && playable.type === 27 && playable.stepMax === 50)
    const root = tables.get('worldmap_6250').filter((row) => row.expandId === playable.id)
    assert.equal(root.length, 1)
    assert.equal(root[0].expandParams, '')
    const origin = root[0].position.split('|').map(Number)
    const objects = new Map(
        playable.objectAoiRanges.split('|').map((token) => {
            const [id, spawner, x, y, z] = token.split('#').map(Number)
            assert([id, spawner, x, y, z].every(Number.isFinite))
            return [id, { spawner, position: { x: origin[0] + x, y: origin[1] + y, z: origin[2] + z } }]
        }),
    )
    assert.equal(objects.get(1).spawner, 70196)
    assert(objects.has(2) && objects.has(3))
    const ai = tables.find('world_ai', 103029)
    assert(ai?.path.endsWith('/bevtree_task_trace_01.asset'))
    const parameters = new Map(
        ai.paramInt.split('|').map((token) => {
            const [key, value] = token.split('#')
            return [key, Number(value)]
        }),
    )
    const path = tables.find('world_path_node', parameters.get('pathId'))
    assert(path && path.sceneId === 6250 && !path.pathJumpNode)
    const points = path.pathNode.split('|').map((token) => {
        const [x, y, z] = token.split('#').map(Number)
        assert([x, y, z].every(Number.isFinite))
        return { x, y, z }
    })
    assert.equal(points.length, 12)
    const checkpoints = new Map([
        [parameters.get('1stStayNo'), 1001],
        [parameters.get('2ndStayNo'), 1002],
    ])
    assert.deepEqual([...checkpoints.keys()], [2, 5])
    // GraphHelper.SetPlayableBluePrintParamData0600a5cf loads the table
    // before playable overrides. Prefab defaults alone are not live values.
    const blueprint = tables.find('world_blueprint', 362011)
    assert(blueprint?.path.endsWith('/ast_task_trace_01.asset'))
    const values = new Map()
    for (const token of blueprint.intParam.split('|')) {
        const [key, raw, ...extra] = token.split('#')
        const value = Number(raw)
        assert(key && !values.has(key) && !extra.length && Number.isSafeInteger(value))
        values.set(key, value)
    }
    const dialogue = (key) => {
        const id = values.get(key)
        assert(Number.isSafeInteger(id) && id > 0 && tables.find('story', id))
        return id
    }
    const dialogues = {
        start: dialogue('startdialogue'),
        alerts: ['1stalertdialogue', '2ndalertdialogue', '3rdalertdialogue'].map(dialogue),
        found: dialogue('founddialogue'),
        tooFar: dialogue('toofardialogue'),
        checkpoints: [dialogue('1stcheckpointdialogue'), dialogue('2ndcheckpointdialogue')],
    }
    assert(values.get('Lostdistance') > 0)
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    assert(distance(points[0], objects.get(1).position) < 0.05)
    assert(distance(points.at(-1), objects.get(3).position) <= 2)
    let phase = 'new',
        started = false,
        next = 0,
        pending = null,
        actor = points[0],
        timer = 0,
        emitted = false
    const events = [],
        arrivals = []
    const definition = {
        playable: 62024,
        map: 6250,
        blueprint: 362011,
        ai: 103029,
        path: path.id,
        start: objects.get(2).position,
        destination: objects.get(3).position,
        points,
        checkpoints: [...checkpoints],
        lostDistance: values.get('Lostdistance'),
        arriveDistance: 2,
        arriveDelay: 1,
        dialogues,
    }
    return {
        definition,
        prepare() {
            assert(['new', 'reset-needed'].includes(phase), 'A reset-ready current trace is required')
            phase = 'prepared'
            next = 0
            pending = null
            actor = points[0]
            timer = 0
            emitted = false
            events.push({
                kind: 'target-ready-and-player-transmit',
                start: definition.start,
                rootStillStarted: started,
            })
            return { needsStart: !started, playerPosition: definition.start }
        },
        acknowledgeStart() {
            started = true
        },
        start() {
            assert(phase === 'prepared' && started)
            phase = 'start-dialogue'
            events.push({ kind: 'start-dialogue', id: dialogues.start })
        },
        startDialogueCallback() {
            assert.equal(phase, 'start-dialogue')
            phase = 'playing'
            events.push({ kind: 'start-dialogue-callback', id: dialogues.start })
        },
        arrive(index, position) {
            assert.equal(phase, 'playing')
            assert.equal(index, next, 'Qualified trace arrivals must follow the current AI path')
            assert(distance(position, points[index]) < 0.05, 'Arrival input differs from the source path point')
            actor = { ...position }
            next++
            arrivals.push({ index, position: actor })
            if (checkpoints.has(index)) {
                pending = checkpoints.get(index)
                phase = 'checkpoint'
                events.push({ kind: 'checkpoint', index, event: pending })
                return pending
            }
            return null
        },
        checkpointEnd(event) {
            assert(phase === 'checkpoint' && pending === event)
            pending = null
            phase = 'playing'
            events.push({ kind: 'checkpoint-dialogue-end', event })
        },
        observePlayer(position, { found = false } = {}) {
            assert(['x', 'y', 'z'].every((key) => Number.isFinite(position[key])))
            if (phase !== 'playing') return
            if (found) {
                phase = 'found-pending'
                events.push({ kind: 'observed-found-callback' })
                return
            }
            if (distance(position, actor) > definition.lostDistance) {
                phase = 'too-far'
                events.push({ kind: 'range-exit' })
            }
        },
        failureCallbacksElapsed() {
            assert(['found-pending', 'too-far'].includes(phase))
            phase = 'reset-needed'
            events.push({ kind: 'failure-callbacks-complete' })
        },
        checkDestination() {
            if (
                phase !== 'playing' ||
                next !== points.length ||
                distance(actor, definition.destination) > definition.arriveDistance
            )
                return false
            phase = 'arriving'
            timer = 0
            events.push({ kind: 'arrival-timer-start', delay: definition.arriveDelay })
            return true
        },
        advanceArrival(seconds) {
            assert(Number.isFinite(seconds) && seconds >= 0)
            if (phase !== 'arriving') return
            timer += seconds
            if (timer >= definition.arriveDelay) {
                phase = 'finish-ready'
                events.push({ kind: 'source-trace-finish-output' })
            }
        },
        takeFinish() {
            if (phase !== 'finish-ready' || emitted) return null
            emitted = true
            phase = 'finished'
            return { success: true, finalStep: playable.stepMax }
        },
        snapshot: () => ({
            phase,
            started,
            next,
            pending,
            timer,
            emitted,
            events: structuredClone(events),
            arrivals: structuredClone(arrivals),
            localObservationsOnly: true,
        }),
    }
}
