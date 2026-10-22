import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { grantRewards } from '../src/rewards.js'
export const cfg = configuration(),
    tables = new Tables(cfg.tables),
    world = new WorldObjectCatalog(tables)
export const count = (s, id) =>
    s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
export function candidates(itemId) {
    const [map, track] = tables.find('common_item', itemId).useFunction.split('|').map(Number)
    const template = [map, 0]
        .flatMap((id) => tables.get('world_filter_mark').filter((r) => r.worldId === id))
        .find((r) => r.trackType === track && r.showIf === 0)
    const types = new Set(
        tables
            .get('playable_track')
            .filter((r) => r.markType === template.markType)
            .map((r) => r.playableType),
    )
    return world
        .get('worldmap_' + map)
        .filter(
            (r) => !r.referObject && r.isstory !== 1 && types.has(world.find('world_spawner', r.spawnerId)?.objectType),
        )
}
export function fixture(itemId = 1800007, file = ':memory:', source = tables) {
    const p = new Protocol(cfg.base),
        store = new Store(file),
        game = new Game(p, store, source, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, data) })
            .map((packet) => ({ id: packet.id, data: p.decode(p.byId.get(packet.id).rsp, packet.payload) }))
    }
    call('EnterGame', { open_id: 'world-detector' })
    const [map] = source.find('common_item', itemId).useFunction.split('|').map(Number)
    const rows = world.get('worldmap_' + map)
    const usable = candidates(itemId).filter(
        (r) =>
            !r.appearCond &&
            !r.disappearCond &&
            r.initStatus !== 1 &&
            (world.find('world_spawner', r.spawnerId).objectType !== 101 || r.expandId),
    )
    store.transact(session.id, 0, (s) => {
        s.world.map_id = map
        s.world.pos = { x: 0, y: 0, z: 0 }
        s.tasks = []
        s.taskRecords = source.get('task').map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.player.sbag_infos.items = []
        grantRewards(source, s, [{ itemtype: 3, itemid: itemId, itemnum: 3 }])
        s.worldObjects = Object.fromEntries(
            rows.map((r) => [map + ':' + r.id, { obj_id: r.id, active: false, complete: false }]),
        )
        s.playableFinishes = {}
        for (const row of usable.slice(0, 2)) s.worldObjects[map + ':' + row.id].active = true
        if (usable.length) s.world.pos = { ...world.object(map, usable[0].id).pos }
    })
    return {
        p,
        store,
        game,
        session,
        call,
        itemId,
        map,
        usable,
        edit: (fn) => store.transact(session.id, 0, fn),
        state: () => store.load(session.id).state,
        search: () => call('FindUnCompletedWorldObj', { item_id: itemId }),
        close: () => store.close(),
    }
}
