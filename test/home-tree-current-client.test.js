import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { homeTreePayload } from '../src/home-tree.js'
import { technologyPoints } from '../src/technology.js'
import { ReplayWindow } from '../src/replay.js'
import { encodeFrame } from '../src/wire.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables)
    let session = {},
        sequence = 1
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get(`CSProto${name}`)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        }
    }
    const call = (name, request = {}) => game.dispatch(session, frame(name, request))
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (state) => {
        state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
        state.player.basic_info.lv = 6
        state.tasks = []
        state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        technologyPoints(tables, state)
    })
    return {
        tables,
        protocol,
        store,
        game,
        frame,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        session: () => session,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
    }
}

function activate(f, count) {
    const valid = f.tables
        .get('home_technology_tree')
        .filter((tree) =>
            f.tables
                .get('home_technology')
                .some((row) => row.type === tree.id && row.level === 1 && (row.newTechnologyProduct || row.buffId)),
        )
    assert(valid.length >= count)
    f.edit((state) => {
        for (const tree of valid.slice(0, count)) state.home.technology.levels[tree.id] = { level: 1, lastTime: 0 }
    })
}
function treeSync(f, packets) {
    const sync = packets.find((packet) => packet.id === 6102)
    assert(sync, 'actual HomeSync publishes the changed tree')
    return f.protocol.decode('SCHomeSync', sync.payload).tree
}

test('current6080 upgrades two legal stages without retired6099 and adds no unconfigured item or point fee', () => {
    const f = fixture('current-tree-two')
    try {
        activate(f, 50)
        // Seeded technology facts also unlock an ordinary home-level mirror.
        // Reconcile that through its real query before isolating tree effects.
        f.call('HomeTechnologyTypeInfo', { type: 1 })
        const before = f.state(),
            progress = homeTreePayload(f.tables, before).process
        assert(
            progress >= f.tables.get('home_landscape_tree').find((row) => row.landscapeTreeStage === 3).upNeedschedule,
        )
        const first = f.call('HomeTreeUpgrade'),
            second = f.call('HomeTreeUpgrade')
        assert.equal(treeSync(f, first).stage, 2)
        assert.equal(treeSync(f, second).stage, 3)
        for (const packets of [first, second])
            assert(
                packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 6080),
                'stage sync precedes the actual6080 acknowledgement',
            )
        const after = f.state()
        assert.equal(after.home.tree.is_new, true, 'legacy presentation metadata is preserved, not faked clear')
        assert.deepEqual(after.player, before.player)
        assert.equal(after.home.technology.spent, before.home.technology.spent)
        assert.deepEqual(after.home.builds, before.home.builds)
        assert.equal(after.home.exp, before.home.exp)
    } finally {
        f.store.close()
    }
})

test('real paid technology study deducts its configured points once and publishes tree progress', () => {
    const f = fixture('current-tree-study')
    try {
        const tree = f.tables.find('home_technology_tree', 10020),
            row = f.tables.get('home_technology').find((row) => row.type === tree.id && row.level === 1)
        const before = f.state(),
            beforePoints = BigInt(before.player.attr_infos.attrs.find((row) => row.attr_id === 205).attr_val)
        const packets = f.call('HomeTechnologyLevelUp', { type: tree.category, subType: tree.id })
        const after = f.state(),
            afterPoints = BigInt(after.player.attr_infos.attrs.find((row) => row.attr_id === 205).attr_val)
        assert.equal(after.home.technology.levels[tree.id].level, 1)
        assert.equal(after.home.technology.spent - before.home.technology.spent, row.point)
        assert.equal(beforePoints - afterPoints, BigInt(row.point))
        assert(treeSync(f, packets).process > homeTreePayload(f.tables, before).process)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
    } finally {
        f.store.close()
    }
})

test('transport retry uses the real replay window; fresh requests after re-login still validate the next stage', () => {
    const f = fixture('current-tree-replay')
    try {
        activate(f, 50)
        const replay = new ReplayWindow(),
            frame = f.frame('HomeTreeUpgrade')
        assert.equal(replay.find(frame), null)
        const packets = f.game.dispatch(f.session(), frame)
        const encoded = packets.map((packet) => encodeFrame(packet, packet.payload))
        replay.save(frame, encoded)
        assert.deepEqual(replay.find(frame), encoded)
        assert.equal(f.state().home.tree.stage, 2, 'identical network retransmission does not dispatch6080 again')
        const login = f.reconnect()
        assert.equal(treeSync(f, login).stage, 2)
        assert.equal(treeSync(f, f.call('HomeTreeUpgrade')).stage, 3)
        assert.equal(f.state().home.tree.is_new, true)
    } finally {
        f.store.close()
    }
})

test('current next threshold and max-stage errors stay atomic even with a legacy is_new flag', () => {
    const f = fixture('current-tree-boundary')
    try {
        activate(f, 10)
        f.call('HomeTreeUpgrade')
        assert.equal(f.state().home.tree.stage, 2)
        let before = f.state()
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (error) => error.code === ErrorCode.HomeTreeProcessNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.home.tree.stage = Math.max(
                ...f.tables.get('home_landscape_tree').map((row) => row.landscapeTreeStage),
            )
        })
        before = f.state()
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (error) => error.code === ErrorCode.HomeTreeLevelIsMax,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('wrong-scene and failed HomeSync encoding never leak a stage, cost or presentation change', () => {
    const f = fixture('current-tree-rollback')
    try {
        activate(f, 50)
        f.edit((state) => {
            state.world.map_id = 100
            state.home.tree.is_new = true
        })
        let before = f.state()
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (error) => error.code === ErrorCode.PlayerNotInHome,
        )
        assert.deepEqual(f.state(), before)
        f.edit((state) => {
            state.world.map_id = Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value)
        })
        before = f.state()
        const packet = f.game.packet.bind(f.game)
        f.game.packet = (name, ...args) => {
            if (name === 'CSProtoHomeSync') throw Error('tree-current-codec')
            return packet(name, ...args)
        }
        assert.throws(() => f.call('HomeTreeUpgrade'), /tree-current-codec/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
