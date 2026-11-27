import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { worldCondition } from '../src/handlers/world-objects.js'

// A bounded driver for real declared world and own-home portals, not a task transfer or
// a reconstruction of the client's pathfinding. Unknown conditions are not
// treated as visible; destination NPC/map markers are never portal evidence.
export function currentScenePortalRoute(tables, state, destination) {
    const homeId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
    assert(Number.isSafeInteger(homeId) && homeId > 0, 'Current home identity required')
    const cities = new Set(
        tables
            .get('world_city')
            .filter((row) => row.type === 1 || (row.id === homeId && row.type === 3 && row.playModule === 'Home'))
            .map((row) => row.id),
    )
    assert(cities.has(state.world.map_id) && cities.has(destination), 'Unqualified world/home scene route')
    const available = (text) => {
        if (!text) return true
        if (
            !String(text)
                .split('|')
                .every((part) => [2004, 2007, 12045].includes(Number(part.split('#')[0])))
        )
            return undefined
        return worldCondition(text, state)
    }
    const catalog = new WorldObjectCatalog(tables),
        queue = [{ map: state.world.map_id, route: [] }]
    const visited = new Set([state.world.map_id])
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor]
        if (current.map === destination) return current.route
        if (!fs.existsSync(path.join(tables.dir, 'worldmap_' + current.map + '.json'))) continue
        for (const row of tables.get('worldmap_' + current.map).toSorted((a, b) => a.id - b.id)) {
            if (tables.find('world_spawner', row.spawnerId)?.objectType !== 303) continue
            const appears = available(row.appearCond)
            const disappears = row.disappearCond ? available(row.disappearCond) : false
            if (appears !== true || disappears !== false) continue
            const options = String(row.interactOptions).split('|').map(Number)
            if (!options.some((id) => tables.find('world_interact', id)?.interactAction === 10)) continue
            const transfers = String(row.interactOverrideParams)
                .split('|')
                .map((part) => part.split('#').map(Number))
                .filter(([kind]) => kind === 10)
            if (transfers.length !== 1 || transfers[0].length !== 2) continue
            const point = tables.find('world_borthpos', transfers[0][1])
            if (!point || !cities.has(point.cityId) || visited.has(point.cityId)) continue
            const object = catalog.object(current.map, row.id)
            const edge = { from: current.map, to: point.cityId, object: row.id, point: point.id, pos: object.pos }
            visited.add(point.cityId)
            queue.push({ map: point.cityId, route: [...current.route, edge] })
        }
    }
    assert.fail('No qualified current world/home portal route to ' + destination)
}

export function walkCurrentScene(f, driver, destination) {
    const route = currentScenePortalRoute(f.tables, f.state(), destination)
    for (const edge of route) {
        assert.equal(f.state().world.map_id, edge.from)
        driver.move(edge.pos)
        driver.call('EnterWorldMap', {
            map_id: edge.to,
            point_id: edge.point,
            creator_id: f.state().player.basic_info.id,
        })
        assert.equal(f.state().world.map_id, edge.to)
    }
    return route
}
