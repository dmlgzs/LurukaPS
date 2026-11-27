import assert from 'node:assert/strict'
import fs from 'node:fs'

const sources = JSON.parse(fs.readFileSync(new URL('../configs/playable-enemies.json', import.meta.url)))
// Bounded descriptor from exact3217420 playable62043 and BP300605.
// The input engine consumes successful local observations;it does not run
// Unity AI,range/occlusion,ecology or a PlayableDirector.
const descriptor = {
    playId: 62043,
    blueprint: 300605,
    sourceSha256: '456368e30fb9c9ca3d725251db06be33d957fe3efe47f468966169bb83ca4777',
    waveTags: ['monster_1', 'monster_2'],
    waveIndexes: [0, 1],
    intervals: [2, 2],
    noChest: true,
    noSunyaCore: false,
    finalStory: 0,
    performanceStep: 4,
}

export function currentSunyaInput(tables, roster) {
    assert.equal(sources.version, '3217420')
    const source = sources.playables.find((row) => row.id === descriptor.playId)
    assert.equal(source.source_sha256, descriptor.sourceSha256)
    const playable = tables.find('playable', descriptor.playId)
    assert(playable.stepMax === 10 && playable.type === 3)
    const roots = tables.get('worldmap_100').filter((row) => row.expandId === playable.id)
    assert.equal(roots.length, 1)
    assert.equal(roots[0].expandParams, '')
    const groups = new Map(source.groups.map((group) => [group.index, group]))
    assert.equal(new Set(roster.map((row) => row.uuid)).size, roster.length)
    assert.equal(
        roster.length,
        source.groups.reduce((sum, group) => sum + group.enemies.length, 0),
    )
    for (const group of source.groups) {
        const rows = roster.filter((row) => row.index === group.index)
        assert.equal(rows.length, group.enemies.length)
        assert(rows.every((row) => row.enemy_group === group.enemy_group && BigInt(row.uuid) >> 56n === 7n))
    }
    const waves = descriptor.waveIndexes.map((index, wave) => ({
        index,
        tag: descriptor.waveTags[wave],
        enemies: groups.get(index).enemies,
        targets: roster.filter((row) => row.index === index).map((row) => row.uuid),
    }))
    const ignored = roster.filter((row) => !descriptor.waveIndexes.includes(row.index)).map((row) => row.uuid)
    let phase = 'ready',
        wave = 0,
        started = false,
        elapsed = 0,
        emitted = false
    const dead = new Set(),
        events = []
    return {
        definition: { ...descriptor, stepMax: playable.stepMax, root: roots[0], waves, ignored },
        enterBattle() {
            assert.equal(phase, 'ready')
            phase = 'battle'
            events.push({ kind: 'current-wave-created-and-entered', wave, index: waves[wave].index })
            return { needsStart: !started, wave: waves[wave] }
        },
        acknowledgeStart() {
            started = true
        },
        observeDead(target) {
            assert(phase === 'battle' && started, 'Actual current battle/start required')
            assert(waves[wave].targets.includes(target), 'Only the active source wave can report deaths')
            dead.add(target)
        },
        observeWaveClear(index) {
            assert(phase === 'battle' && waves[wave].index === index)
            assert(
                waves[wave].targets.every((target) => dead.has(target)),
                'Every active-wave target must be dead before the clear observation',
            )
            events.push({ kind: 'current-wave-clear', wave, index, targets: waves[wave].targets })
            wave++
            elapsed = 0
            phase = wave < waves.length ? 'interval' : 'performance-pending'
        },
        advance(seconds) {
            assert(Number.isFinite(seconds) && seconds >= 0)
            if (phase !== 'interval') return
            elapsed += seconds
            if (elapsed >= descriptor.intervals[wave]) phase = 'ready'
        },
        beginFinalPerformance() {
            assert.equal(phase, 'performance-pending')
            phase = 'performance'
            events.push({ kind: 'current-final-director-start', synchronizedStep: descriptor.performanceStep })
            return descriptor.performanceStep
        },
        observeFinalDirectorEnd() {
            assert.equal(phase, 'performance')
            phase = 'finish-ready'
            events.push({ kind: 'current-final-director-end-observed' })
        },
        takeFinish() {
            if (phase !== 'finish-ready' || emitted) return null
            emitted = true
            phase = 'finished'
            return { playId: playable.id, step: playable.stepMax }
        },
        snapshot: () => ({
            phase,
            wave,
            started,
            elapsed,
            dead: [...dead],
            events: structuredClone(events),
            localObservationsOnly: true,
        }),
    }
}
