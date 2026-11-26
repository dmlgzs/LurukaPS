import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

// Normal destination is LurukaPS/test. The override only permits running this
// unchanged candidate from work; it is not an input containing saved results.
const project = fs.realpathSync(
    process.env.LURUKAPS_CATALOGUE_TEST_ROOT ?? fileURLToPath(new URL('../', import.meta.url)),
)
const base = pathToFileURL(project + path.sep)
const obsoleteSnapshot = new URL('configs/material-blueprint-stages.json', base).href
let obsoleteLoadRequests = 0
const dependencyGuard = registerHooks({
    load(url, context, nextLoad) {
        if (url === obsoleteSnapshot) {
            obsoleteLoadRequests++
            throw Error('Current material catalogue must not depend on the obsolete snapshot')
        }
        return nextLoad(url, context)
    },
})
after(() => dependencyGuard.deregister())

const { configuration } = await import(new URL('src/config.js', base))
const { Tables } = await import(new URL('src/player.js', base))
const { EntrustCatalog } = await import(new URL('src/entrust.js', base))
const { materialBlueprintStages } = await import(new URL('src/material-blueprint-stages.js', base))
const { ErrorCode } = await import(new URL('src/error-codes.js', base))
const tables = new Tables(configuration().tables)
const catalogue = new EntrustCatalog(tables)
const targets = new Map([
    [30604, 60064],
    [30803, 60033],
    [30804, 60034],
])

function indexedStages(scene) {
    return tables
        .get(`worldmap_${scene.id}`)
        .flatMap((row) => {
            const token = String(row.expandParams ?? '')
                .split('|')
                .find((part) => part.toLowerCase().startsWith('autobattleindex#'))
            return token
                ? [
                      {
                          index: Number(token.split('#')[1]),
                          type: tables.find('world_spawner', row.spawnerId)?.objectType,
                          row,
                      },
                  ]
                : []
        })
        .sort((a, b) => a.index - b.index)
}

test('current material/weekly catalogue resolves all110 routes from current tables without old saved expectations', () => {
    const materials = tables.get('dungeon_material'),
        weekly = tables.get('dungeon_weekly')
    assert.equal(materials.length, 92)
    assert.equal(weekly.length, 18)
    let parsed = 0,
        explicitMaterials = 0
    for (const [kind, records] of [
        ['material', materials],
        ['weekly', weekly],
    ]) {
        for (const record of records) {
            const config = catalogue.get(record.id, kind),
                stages = catalogue.stages(record.id, kind)
            const victory = catalogue.victoryObjects(record.id, kind),
                chest = catalogue.chest(record.id, kind)
            assert.equal(config.dungeon.id, record.dungeonId)
            assert.equal(config.city.type, 12)
            assert.equal(config.scene.mapId, config.city.id)
            assert.equal(chest.worldFilter, `4|${record.dungeonId}`)
            assert.equal(chest.worldmapcityid, config.scene.id)
            assert.equal(stages[0].type, 13)
            assert.equal(stages.at(-1).type, 30)
            assert.equal(stages.at(-1).row.id, chest.worldmapid)
            assert.equal(new Set(stages.map((stage) => stage.row.id)).size, stages.length)
            assert(stages.every((stage, index) => index === 0 || stage.index > stages[index - 1].index))
            const groups = stages.filter((stage) => stage.type === 50)
            assert.equal(groups.length, victory.length)
            assert.deepEqual(
                groups.map((stage) => stage.row.id).sort((a, b) => a - b),
                victory.map((row) => row.objectId).sort((a, b) => a - b),
            )
            for (const group of groups) {
                const definition = tables.find('world_enemy_group', group.row.expandId)
                assert(definition)
                const packs = String(definition.enemyList).split('|').filter(Boolean).map(Number)
                assert.equal(packs.length, victory.find((row) => row.objectId === group.row.id).count)
                assert(packs.every((id) => tables.find('enemy_pack', id)))
            }
            if (kind === 'material' && !targets.has(record.id)) {
                const indexed = indexedStages(config.scene)
                assert.equal(materialBlueprintStages(tables, config.scene, record, indexed), indexed)
                explicitMaterials++
            }
            parsed++
        }
    }
    assert.equal(parsed, 110)
    assert.equal(explicitMaterials, 89)
})

test('three current B routes use their exact dual-blueprint marker/enemy/chest bindings', () => {
    const capability = JSON.parse(fs.readFileSync(new URL('configs/material-front-execution.json', base)))
    assert.equal(capability.clientVersion, '1.0.0')
    assert.equal(capability.packageVersion, '3217420')
    assert.equal(capability.policy.origin, 'LOCAL')
    for (const [id, map] of targets) {
        const config = catalogue.get(id, 'material'),
            stages = catalogue.stages(id, 'material')
        assert.equal(config.scene.id, map)
        assert.equal(config.scene.blueprintId, 300358)
        assert.equal(config.scene.serverBlueprintId, 300351)
        assert.deepEqual(
            stages.map((stage) => [stage.index, stage.type, stage.row.id]),
            [
                [1, 13, 3],
                [2, 50, 5],
                [3, 50, 6],
                [4, 30, 4],
            ],
        )
        const matching = capability.scenes.filter(
            (scene) => scene.material_id === id && scene.dungeon_id === config.dungeon.id && scene.scene_id === map,
        )
        assert.equal(matching.length, 1)
        assert.deepEqual(
            matching[0].stages.map((stage) => stage.object_id),
            stages.map((stage) => stage.row.id),
        )
        assert.deepEqual(matching[0].victory.object_ids, [5, 6])
        assert.equal(matching[0].chest.object_id, catalogue.chest(id, 'material').worldmapid)
    }
})

test('unknown missing-stage topologies including a synthetic front351 reject with named FunctionClosed', () => {
    const record = tables.find('dungeon_material', 30604),
        { scene } = catalogue.get(record.id, 'material')
    const indexed = indexedStages(scene),
        before = JSON.stringify(tables.get(`worldmap_${scene.id}`))
    assert.deepEqual(
        indexed.map((stage) => stage.row.id),
        [3, 4],
    )
    for (const patch of [
        { blueprintId: 0, serverBlueprintId: 0 },
        { blueprintId: 300351, serverBlueprintId: 0 },
        { blueprintId: 300358, serverBlueprintId: 0 },
        { blueprintId: 987654321, serverBlueprintId: 0 },
    ]) {
        assert.throws(
            () => materialBlueprintStages(tables, { ...scene, ...patch }, record, indexed),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
    }
    assert.equal(JSON.stringify(tables.get(`worldmap_${scene.id}`)), before)
})

test('fresh module graph and all catalogue paths request no obsolete material snapshot', () => {
    assert.equal(obsoleteLoadRequests, 0)
})
