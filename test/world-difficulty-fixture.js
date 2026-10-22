import { achievementFixture } from './achievement-fixture.js'
import { worldDifficultyCatalogue } from '../src/world-difficulty-catalogue.js'
import { enemyDefinition } from '../src/enemy-state.js'

export function worldDifficultyFixture(name, file) {
    const f = achievementFixture(name, file)
    f.store.transact(f.session.id, 0, (s) => {
        s.world.map_id = 100
        s.world.pos = { x: 100, y: 200, z: 300 }
    })
    const unlock = (mapId, level) => {
        const row = worldDifficultyCatalogue(f.tables).maps.get(mapId).get(level)
        const [kind, ...p] = row.condition.split('#').map(Number)
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords ??= []
            if ([2007, 12045].includes(kind) && !s.taskRecords.some((t) => t.task_id === p[0]))
                s.taskRecords.push({ task_id: p[0], count: 1, time: 1799999900 })
        })
    }
    const enemy = (hpRatio = 1, dead = false) => {
        const row = f.tables.get('boss_first_chest_drop').find((r) => String(r.WorldFilter).split('|')[0] === '100')
        const object = Number(String(row.WorldFilter).split('|')[1]),
            uuid = ((3n << 56n) | BigInt(object)).toString()
        const definition = enemyDefinition(f.tables, f.state(), uuid)
        if (!definition) throw Error('Missing real difficulty enemy')
        f.store.transact(f.session.id, 0, (s) => {
            s.combat = {
                map_id: 100,
                entities: {
                    [uuid]: {
                        ...definition,
                        uuid,
                        hp: dead ? 0 : Math.max(1, Math.floor(definition.max_hp * hpRatio)),
                        alive_state: dead ? 1 : 0,
                        updated_at: 1799999900,
                    },
                },
                skills: {},
                elements: {},
                bullets: {},
                hatred: { objects: {}, players: {} },
            }
        })
        return { uuid, definition }
    }
    return { ...f, unlock, enemy }
}
