import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
function fixture(dungeon) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: 'interaction-range-' + dungeon })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.player.basic_info.lv = 45
        s.taskRecords = [{ task_id: 106013, count: 1 }]
        s.entrust = {
            records: { 8: { entrust_id: 8, entrust_star: 1, success_time: '1' } },
            starRewards: {},
            nextInstanceId: 1,
        }
    })
    let plan
    if (dungeon) {
        call('MultiCampaignCreate', { dungeon_id: dungeon, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        plan = materialStoryPlan(tables, state().entrust.run)
    }
    const interact = () =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: plan.trigger_id,
                        complete: dungeon === 35750,
                        pos: plan.pos,
                        state_data: { children: [] },
                    },
                    pos: plan.pos,
                    interact_type: 0,
                },
            ],
        })
    return { protocol, store, session, call, edit, state, plan, interact, close: () => store.close() }
}

test('material and weekly intro HUD clicks accept the extra metre, but reject one centimetre beyond it atomically', () => {
    for (const dungeon of [312, 35750]) {
        const f = fixture(dungeon)
        try {
            // The actual material table supplies 40m; the weekly table supplies 10m.
            assert.equal(f.plan.range, dungeon === 312 ? 4000 : 1000)
            f.edit((s) => {
                s.world.pos = { ...f.plan.pos, x: f.plan.pos.x + f.plan.range + 1101 }
            })
            const before = f.state()
            assert.throws(
                () => f.interact(),
                (e) => e.code === ErrorCode.InvalidArgument && /too far/.test(e.message),
            )
            assert.deepEqual(f.state(), before, 'a rejected click cannot complete the marker or start the story')
            f.edit((s) => {
                s.world.pos.x--
            })
            const packets = f.interact()
            assert.equal(packets.filter((p) => p.id === 11270).length, 1)
            assert.equal(f.state().entrust.run.materialStory.phase, 'playing')
            assert.equal(f.state().entrust.run.battle_start_time, undefined, 'reach must not bypass real story END')
        } finally {
            f.close()
        }
    }
})

test('current weekly entry click works from its real spawn and never grants early battle control', () => {
    const f = fixture(35750)
    try {
        const pos = f.state().world.pos
        const distance = Math.hypot(...['x', 'y', 'z'].map((k) => pos[k] - f.plan.pos[k]))
        assert(distance > 1100 && distance < 2000, 'one metre alone does not cover the real clickable entry')
        const packets = f.interact(),
            control = f.protocol.byName.get('SCProtoControlChangeByAddNtf').id
        const boss = ((3n << 56n) | BigInt(f.plan.boss_id)).toString()
        assert(packets.some((p) => p.id === 11270))
        assert(
            !packets.some(
                (p) =>
                    p.id === control &&
                    f.protocol.decode(f.protocol.byId.get(control).rsp, p.payload).agent_uid === boss,
            ),
        )
    } finally {
        f.close()
    }
})

test('intro reach uses accepted pending movement and rolls back if the story packet cannot encode', () => {
    const f = fixture(35750)
    try {
        const formation = f.state().player.group_mgrs.find((m) => m.type === 1),
            control = formation.groups.find((g) => g.id === formation.cur_group).control,
            pos = { ...f.plan.pos, z: f.plan.pos.z + 2050 },
            changes = () => f.store.db.prepare('SELECT total_changes() AS n').get().n,
            sqlBefore = changes()
        f.call('StateUpdate', {
            move_msg: {
                map_id: f.plan.map_id,
                move: [{ uuid: control, info: { pos, angle: 0, timestamp: '1800000000001', is_ground: 1 } }],
            },
        })
        assert.equal(changes(), sqlBefore)
        assert.deepEqual(f.state().world.pos, pos)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byName.get('SCProtoPlayerStoryStart').rsp) throw Error('range story encode failure')
            return encode(name, data)
        }
        assert.throws(() => f.interact(), /range story encode failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert(f.interact().some((p) => p.id === 11270))
    } finally {
        f.close()
    }
})

test('ordinary collection gains exactly one metre of tolerance, with target coordinates unable to bypass player distance', () => {
    const f = fixture(),
        catalog = new WorldObjectCatalog(tables),
        pos = catalog.object(101, 500171).pos
    try {
        f.edit((s) => {
            s.world.map_id = 101
            s.world.pos = { ...pos, x: pos.x + 5101 }
        })
        const request = {
                objs: [{ obj: { obj_id: 500171, complete: true, pos, state_data: {} }, pos, interact_type: 0 }],
            },
            before = f.state()
        assert.throws(() => f.call('WorldObjInteract', request), /too far/)
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.world.pos.x--
        })
        assert(f.call('WorldObjInteract', request).some((p) => p.id === 9133))
        assert.equal(f.state().worldObjects['101:500171'].complete, true)
        const bag = structuredClone(f.state().player.sbag_infos)
        f.call('WorldObjInteract', request)
        assert.deepEqual(f.state().player.sbag_infos, bag, 'range relaxation must not grant a second reward')
    } finally {
        f.close()
    }
})
