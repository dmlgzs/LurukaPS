import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { cultivationGuideDungeon, activityGuideIssues } from '../src/activity-access.js'
import { ActivityCatalog } from '../src/activities.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const withDungeons = (rows) => {
    const scoped = Object.create(tables)
    scoped.get = (name) => (name === 'dungeon' ? rows : tables.get(name))
    scoped.find = tables.find.bind(tables)
    return scoped
}

test('current cultivation guide uses the exact group and first difficulty, including230→10082 rather than row230', () => {
    const first = tables.get('game_events_cul').find((row) => row.Id === 60001)
    const hunting = tables.get('game_events_cul').find((row) => row.Id === 60002)
    assert.equal(first.taskDungeon, 905)
    assert.equal(cultivationGuideDungeon(tables, first.taskDungeon).id, 905)
    assert.equal(hunting.taskDungeon, 230)
    assert.equal(tables.find('dungeon', 230), undefined)
    const resolved = cultivationGuideDungeon(tables, hunting.taskDungeon)
    assert.equal(resolved.id, 10082)
    assert.equal(resolved.groupId, 230)
    assert.equal(resolved.dungeonGroupOrder, 1)
    assert.deepEqual(activityGuideIssues(tables, tables.find('game_events', 60001)), [])
    assert.deepEqual(activityGuideIssues(tables, tables.find('game_events', 60002)), [{ table: 'task', id: 900001 }])
})

test('a row ID coincidence or another difficulty cannot replace the required group first difficulty', () => {
    const actual = cultivationGuideDungeon(tables, 230)
    const wrong = withDungeons([
        { ...actual, id: 230, groupId: 999999 },
        { ...actual, dungeonGroupOrder: 2 },
    ])
    assert.equal(cultivationGuideDungeon(wrong, 230), undefined)
    assert.deepEqual(activityGuideIssues(wrong, tables.find('game_events', 60002)), [
        { table: 'task', id: 900001 },
        { table: 'dungeon', group_id: 230, difficulty: 1 },
    ])
    assert.equal(
        cultivationGuideDungeon(withDungeons([actual, { ...actual, id: 10083, dungeonGroupOrder: 2 }]), 230).id,
        10082,
    )
})

test('ambiguous or damaged declared guide definitions fail as configuration errors rather than picking an arbitrary row', () => {
    const actual = cultivationGuideDungeon(tables, 230)
    const damaged = [withDungeons([actual, { ...actual, id: 10083 }]), withDungeons([{ ...actual, id: '10082' }])]
    for (const data of damaged)
        assert.throws(
            () => cultivationGuideDungeon(data, 230),
            (error) => error.code === ErrorCode.GameConfig,
        )
    for (const id of [0, -1, '230', NaN])
        assert.throws(
            () => cultivationGuideDungeon(tables, id),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () =>
            cultivationGuideDungeon(
                {
                    get() {
                        throw Error('broken declared dungeon table')
                    },
                },
                230,
            ),
        /broken declared dungeon table/,
    )
})

test('resolving the real guide dungeon keeps the missing task gate and distinguishes it from missing dungeon definitions', () => {
    const catalog = new ActivityCatalog(tables)
    assert.equal(cultivationGuideDungeon(tables, 230).id, 10082)
    assert.throws(
        () => catalog.requireGuideConfiguration(tables.find('game_events', 60002)),
        (error) => error.code === ErrorCode.TaskConfFail,
    )
    const first = tables.get('game_events_cul').find((row) => row.Id === 60001)
    const missingFirst = withDungeons(
        tables.get('dungeon').filter((row) => !(row.groupId === first.taskDungeon && row.dungeonGroupOrder === 1)),
    )
    const isolated = new ActivityCatalog(missingFirst)
    assert.throws(
        () => isolated.requireGuideConfiguration(tables.find('game_events', 60001)),
        (error) => error.code === ErrorCode.DungeonConfNotExist,
    )
})
