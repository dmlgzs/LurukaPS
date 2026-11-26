import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroModules, petModules, heroBattleLimits } from '../src/battle.js'
import { group } from '../src/handlers/common.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    action = tables.find('world_interact', 33)
assert.equal(action.interactAction, 66)

// Current FSM1004/1068 bodies (case birth-point-heal-current-agent) add ID33
// on selfEntity in their completed state and remove it when incomplete.
// Actual prefab150 root scale1, spawner26004 scale1 and row overrides supply
// the host transform below. This is still not a Unity collision simulator.
// Current TranspointRecoverAction0602813b and EntityService06028719 provide
// the gating/request and presence-aware sync contracts tested here.
class RecoveryConsumer {
    constructor() {
        this.actors = new Map()
        this.formation = []
        this.map = 0
        this.requests = []
        this.completed = 0
    }
    request(host, event, pos) {
        if (host.enabled === false || host.map !== this.map || ![1, 2].includes(event)) return false
        const range = action.interactRange * host.scale * 100,
            dx = pos.x - host.pos.x,
            dz = pos.z - host.pos.z
        // Samples deliberately use equal height and avoid the cylinder edge;
        // Native GCylinder collision/probe radius is not approximated here.
        if (pos.y !== host.pos.y || dx * dx + dz * dz >= range * range) return false
        const heroes = this.formation.map((id) => this.actors.get(id))
        if (heroes.every((hero) => hero.hp <= 0 || hero.alive_state !== 0)) return false
        const ids = new Set(this.formation)
        for (const actor of this.actors.values()) if (ids.has(actor.hero)) ids.add(actor.guid)
        if (![...ids].some((id) => this.actors.get(id).hp < this.actors.get(id).max)) return false
        this.requests.push({ type: 3 })
        return true
    }
    consume(packets, recovery = false) {
        for (const packet of packets) {
            if (packet.id === 10009) {
                const data = protocol.decode(protocol.byId.get(10009).rsp, packet.payload)
                for (const info of data.infos ?? []) {
                    if (info.reason !== 1) continue
                    const actor = this.actors.get(info.uuid)
                    if (!actor) {
                        assert(!recovery, 'Recovery must only target known active own actors')
                        continue
                    }
                    if (Object.hasOwn(info, 'hp')) {
                        assert(
                            info.hp >= 0 && info.hp <= actor.max,
                            `actor ${info.uuid}: hp ${info.hp}, max ${actor.max}`,
                        )
                        actor.hp = info.hp
                    }
                    if (Object.hasOwn(info, 'alive_state')) actor.alive_state = info.alive_state
                    if (Object.hasOwn(info, 'sp')) actor.sp = info.sp
                    assert.equal(info.reason, 1)
                }
            }
            if (packet.id === 9102) this.completed++
        }
    }
}

function currentStarHost(row, snapshot) {
    const spawner = tables.find('world_spawner', row.spawnerId),
        fsm = row.fsm || spawner.fsm,
        expected = new Map([
            [1004, 'Config/World/Graph/FSM/ast_fsm_common_world_transfer_point.asset'],
            [1068, 'Config/World/Graph/FSM/ast_fsm_common_world_transfer_point_no_astraxiom.asset'],
        ])
    assert.equal(spawner.objectType, 21)
    assert.equal(spawner.resourceId, 150)
    assert.equal(
        tables.find('world_item', 150).resPath.split(',')[0],
        'FieldItem/World/pre_orctribes_transmit_01.prefab',
    )
    assert.equal(tables.find('world_fsm', fsm).path, expected.get(fsm))
    const xyz = row.position.split('|').map((value) => Math.round(Number(value) * 100))
    return {
        map: row.cityId,
        scale: row.scale || spawner.scale,
        pos: { x: xyz[0], y: xyz[1], z: xyz[2] },
        enabled: snapshot.map_info.objs?.find((obj) => obj.obj_id === row.id)?.complete ?? !!row.initialCompleteState,
    }
}

function fixture(name) {
    const store = new Store(':memory:'),
        session = {},
        client = new RecoveryConsumer()
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
        client.consume(
            packets.filter((packet) => packet.id !== 10009 || client.actors.size),
            name === 'WorldMapActiveBehavior',
        )
        return packets
    }
    call('EnterGame', { open_id: 'birth-heal-current-' + name })
    const state = () => store.load(session.id).state,
        heroes = [101010, 107001].map((id) => state().player.heros_info.heros.find((hero) => hero.conf_id === id)),
        pet = state().pets.find((pet) => !pet.work_status && tables.find('template_value', pet.config_id))
    assert(heroes.every(Boolean) && pet)
    const active = group(state())
    call('QuickChangeGroupInfo', {
        type: 1,
        id: active.id,
        infos: heroes.map((hero, index) => ({ hero_guid: hero.guid, pet_guid: index === 0 ? pet.guid : '0' })),
    })
    const edit = (fn) => store.transact(session.id, 0, fn)
    const hurt = ({ allDead = false } = {}) => {
        const current = state(),
            modules = heroes.map((hero) =>
                heroModules(
                    tables,
                    current,
                    current.player.heros_info.heros.find((row) => row.guid === hero.guid),
                ),
            )
        client.formation = heroes.map((hero) => hero.guid)
        for (const [index, hero] of heroes.entries()) {
            const max = heroBattleLimits(modules[index]).hp
            client.actors.set(hero.guid, {
                guid: hero.guid,
                hp: allDead || index === 1 ? 0 : 1,
                max,
                sp: 7,
                alive_state: allDead || index === 1 ? 1 : 0,
            })
        }
        client.actors.set(pet.guid, {
            guid: pet.guid,
            hero: heroes[0].guid,
            hp: 0,
            max: heroBattleLimits(
                petModules(
                    tables,
                    current,
                    current.pets.find((row) => row.guid === pet.guid),
                    modules,
                ),
            ).hp,
            sp: 9,
            alive_state: 1,
        })
        edit((draft) => {
            for (const hero of heroes) {
                const row = draft.player.heros_info.battle_infos.find((row) => row.hero_id === hero.guid),
                    actor = client.actors.get(hero.guid)
                Object.assign(row, { hp: actor.hp, sp: actor.sp, alive_state: actor.alive_state })
            }
            draft.combat = {
                map_id: draft.world.map_id,
                skills: {},
                bullets: {},
                elements: {},
                petSp: { [pet.guid]: 9 },
                entities: { [pet.guid]: { uuid: pet.guid, hp: 0, alive_state: 1 } },
            }
        })
    }
    const move = (pos, actor = group(state()).control) =>
        call('StateUpdate', {
            move_msg: {
                map_id: state().world.map_id,
                move: [{ uuid: actor, info: { pos, angle: 123, is_ground: 1 } }],
            },
        })
    const recover = () => {
        assert.equal(client.requests.length, 1)
        return call('WorldMapActiveBehavior', client.requests.shift())
    }
    return {
        store,
        session,
        game,
        state,
        client,
        heroes,
        pet,
        call,
        edit,
        hurt,
        move,
        recover,
        advance() {
            now += 60
            return game.tick(session.id, session)
        },
    }
}

for (const map of [100, 200])
    test(`current recovery action in map${map} consumes9102/10009 to restore only formation HP without relocating or refilling SP`, (t) => {
        const f = fixture('map-' + map)
        try {
            let entry = f.call('WorldPoint', { point_id: map === 100 ? 10045 : 20005 })
            const hostObject = tables.get('worldmap_' + map).find((row) => row.spawnerId === 26004)
            if (map === 100) {
                // Valid already-activated save baseline. Activation rewards
                // are a separate flow, not an extra precondition in9102.
                f.edit((draft) => {
                    draft.worldObjects ??= {}
                    draft.worldObjects[map + ':' + hostObject.id] = {
                        obj_id: hostObject.id,
                        complete: true,
                        state_data: { step: 1, complete: true },
                    }
                })
                entry = f.call('EnterWorldMap', { map_id: map })
            } else assert.equal(hostObject.initialCompleteState, 1)
            const world = protocol.decode(
                    protocol.byId.get(9103).rsp,
                    entry.find((packet) => packet.id === 9103).payload,
                ),
                override = world.map_info.objs?.find((obj) => obj.obj_id === hostObject.id),
                saved = f.state().worldObjects?.[map + ':' + hostObject.id]
            assert.equal(world.map_id, map)
            if (override && Object.hasOwn(override, 'complete')) assert.equal(override.complete, true)
            if (saved && Object.hasOwn(saved, 'complete')) assert.equal(saved.complete, true)
            if (map === 200 && !override)
                assert.equal(
                    hostObject.initialCompleteState,
                    1,
                    'No false override replaces the static active star-node',
                )
            const host = currentStarHost(hostObject, world)
            t.diagnostic(
                JSON.stringify({
                    map,
                    object: hostObject.id,
                    fsm: hostObject.fsm || tables.find('world_spawner', hostObject.spawnerId).fsm,
                    staticComplete: hostObject.initialCompleteState,
                    storedOverride: saved?.complete ?? null,
                    wireOverride: override?.complete ?? null,
                    hostPos: host.pos,
                    hostScale: host.scale,
                    range: action.interactRange * host.scale,
                }),
            )
            assert(host.enabled)
            f.client.map = map
            f.hurt()
            const pos = { ...host.pos, x: host.pos.x + 100 }
            f.move(pos)
            const before = f.state(),
                bench = before.player.heros_info.battle_infos.find((row) => !f.client.formation.includes(row.hero_id))
            assert(f.client.request(host, 2, pos))
            const packets = f.recover(),
                after = f.state()
            assert.deepEqual(after.world, before.world)
            assert.deepEqual(after.player.group_mgrs, before.player.group_mgrs)
            assert(!packets.some((packet) => [9103, 5008, 10006].includes(packet.id)))
            assert(
                packets.findIndex((packet) => packet.id === 10009) < packets.findIndex((packet) => packet.id === 9102),
            )
            for (const actor of f.client.actors.values()) {
                assert.equal(actor.hp, actor.max)
                assert.equal(actor.alive_state, 0)
                assert.equal(actor.sp, actor.hero ? 9 : 7)
            }
            for (const hero of f.heroes) {
                const row = after.player.heros_info.battle_infos.find((row) => row.hero_id === hero.guid)
                assert.equal(row.hp, f.client.actors.get(hero.guid).max)
                assert.equal(row.sp, 7)
            }
            assert.deepEqual(
                after.player.heros_info.battle_infos.find((row) => row.hero_id === bench.hero_id),
                bench,
            )
            assert.equal(after.combat.entities[f.pet.guid].hp, f.client.actors.get(f.pet.guid).max)
            assert.equal(after.combat.petSp[f.pet.guid], 9)
            assert.equal(f.client.request(host, 2, pos), false, 'Full HP does not trigger another client request')
        } finally {
            f.store.close()
        }
    })

test('current action gates all-dead, leaving range and old-map hosts without creating a server recovery timer', () => {
    const f = fixture('gates')
    try {
        f.call('WorldPoint', { point_id: 10045 })
        const pos = f.state().world.pos,
            host = { map: 100, scale: 1, pos }
        f.client.map = 100
        f.hurt({ allDead: true })
        assert.equal(f.client.request(host, 1, pos), false)
        f.hurt()
        assert.equal(
            f.client.request({ ...host, enabled: false }, 1, pos),
            false,
            'Incomplete star-node FSM removes ID33',
        )
        const outside = { ...pos, x: pos.x + 100000 }
        f.move(outside)
        assert.equal(f.client.request(host, 2, outside), false)
        assert.equal(f.client.request(host, 3, pos), false, 'Leave event is not enter/stay')
        const before = f.state().player.heros_info.battle_infos
        f.advance()
        assert.deepEqual(f.state().player.heros_info.battle_infos, before)
        assert.equal(f.client.requests.length, 0)
        f.call('WorldPoint', { point_id: 20005 })
        f.client.map = 200
        assert.equal(f.client.request(host, 1, pos), false)
    } finally {
        f.store.close()
    }
})

test('current checkpoint and real type21 world-object reward do not restore injured formation HP', () => {
    const f = fixture('not-reward')
    try {
        f.call('WorldPoint', { point_id: 10045 })
        f.hurt()
        const before = structuredClone(f.state().player.heros_info.battle_infos),
            checkpoint = tables.get('world_borthpos').find((row) => row.cityId === 100 && row.type === 4),
            opened = f.call('WorldCheckpointOpen', {
                checkpoint_id: checkpoint.id,
                checkpoint_infos: [{ checkpoint_type: 0 }],
            })
        assert(!opened.some((packet) => packet.id === 10009))
        assert.deepEqual(f.state().player.heros_info.battle_infos, before)
        const object = tables.get('worldmap_100').find((row) => row.id === 1001411),
            xyz = object.position.split('|').map((value) => Math.round(Number(value) * 100))
        assert.equal(object.statusReward, '1001410')
        f.edit((draft) => {
            draft.world.points = draft.world.points.filter((id) => id !== 1001410)
            delete draft.worldObjects?.['100:1001411']
        })
        f.move({ x: xyz[0], y: xyz[1], z: xyz[2] })
        const packets = f.call('WorldObjInteract', {
            objs: [{ obj: { obj_id: object.id, complete: true, state_data: { step: 1, complete: true } } }],
        })
        assert(f.state().world.points.includes(1001410))
        assert(packets.some((packet) => packet.id === 9105))
        assert(!packets.some((packet) => packet.id === 10009))
        assert.deepEqual(f.state().player.heros_info.battle_infos, before)
    } finally {
        f.store.close()
    }
})

test('current mounted movement followed by a real map transfer clears riding and cannot reuse the previous recovery host', () => {
    const f = fixture('mount-map')
    try {
        f.call('WorldPoint', { point_id: 10045 })
        f.hurt()
        const mount = f.state().pets.find((pet) => !pet.work_status && tables.find('mount', pet.config_id)),
            host = { map: 100, scale: 1, pos: { ...f.state().world.pos } }
        assert(mount)
        f.call('WorldMapPlayerStatus', { status: 1, arg: mount.guid })
        assert.equal(f.state().world.mount, mount.guid)
        const pos = { ...host.pos, x: host.pos.x + 100 }
        f.move(pos, mount.guid)
        assert.deepEqual(f.state().world.pos, pos)
        f.call('WorldPoint', { point_id: 20005 })
        assert.equal(f.state().world.map_id, 200)
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.status, 0)
        f.client.map = 200
        assert.equal(f.client.request(host, 1, pos), false)
        assert.equal(f.client.requests.length, 0)
    } finally {
        f.store.close()
    }
})
