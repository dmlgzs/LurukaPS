import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { registerBulletRebounds } from '../src/bullet-rebound.js'

function fixture() {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const sessions = [{}, {}],
        offline = new Set()
    const isOnline = (id) => sessions.some((session) => session.id === id && session.entered) && !offline.has(id)
    const connectionKey = (id) => sessions.find((session) => session.id === id && session.entered)?.token ?? null
    game.legacyMatchTeams.isOnline = isOnline
    game.legacyMatchTeams.connectionKey = connectionKey
    // The same public registration used by the required Game constructor hook.
    if (!game.handlers.has(11143))
        registerBulletRebounds((name, handler) => game.handlers.set(protocol.byName.get(name).id, handler), store, {
            isOnline,
            connectionKey,
        })
    const frame = (name, request) => {
        const entry = protocol.byName.get(name) ?? protocol.byName.get(`CSProto${name}`)
        return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) }
    }
    const call = (index, name, request) => game.dispatch(sessions[index], frame(name, request))
    for (let index = 0; index < 2; index++) {
        call(index, 'EnterGame', { open_id: `rebound-${index}` })
        store.transact(sessions[index].id, 0, (state) => {
            state.world.map_id = 100
            state.tasks = []
            state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        })
    }
    const state = (index) => store.load(sessions[index].id).state
    const heroes = sessions.map((_, index) => state(index).player.heros_info.heros.find((hero) => hero.type === 1).guid)
    call(1, 'CreateBullet', {
        unit_id: heroes[1],
        bullet_info: [{ bullet_id: '555', config_id: 100, skill_id: 19900101 }],
        op_time: '1800000000000',
    })
    const request = { target_id: '555', cast_id: heroes[0], skill_id: 19900101, op_time: '1800000000010' }
    const confirmation = { ...request, result: 1, op_time: '1800000000020' }
    return {
        offline,
        store,
        protocol,
        game,
        sessions,
        state,
        heroes,
        frame,
        call,
        request,
        confirmation,
        advance: (seconds) => {
            now += seconds
        },
    }
}
const pick = (packets, id) => packets.filter((packet) => packet.id === id)

test('real CreateBullet -> owner arbitration -> remove -> confirmation routes once and preserves all consumable assets', () => {
    const f = fixture()
    try {
        const bags = [f.state(0).player.sbag_infos, f.state(1).player.sbag_infos]
        const first = pick(f.call(0, 'CSReboundBulletReq', f.request), 11144)
        assert.equal(first.length, 1)
        assert.equal(first[0].recipient, f.sessions[1].id)
        assert.deepEqual(f.protocol.decode('CSReboundBullet', first[0].payload), f.request)
        assert.equal(f.state(1).combat.reboundRequests['555'].requester, f.sessions[0].id)
        // Current owner IL sends action3 before its result notification.
        f.call(1, 'BulletActionChange', {
            action_info: [{ unit_id: f.heroes[1], bullet_id: '555', action_type: 3 }],
            op_time: '1800000000015',
        })
        const second = pick(f.call(1, 'CSReboundBulletNtfReq', f.confirmation), 11146)
        assert.equal(second.length, 1)
        assert.equal(second[0].recipient, f.sessions[0].id)
        assert.deepEqual(f.protocol.decode('SCReboundBulletNtf', second[0].payload), f.confirmation)
        assert.equal(f.state(1).combat.bullets['555'].rebounded, true)
        assert.equal(pick(f.call(1, 'CSReboundBulletNtfReq', f.confirmation), 11146).length, 0)
        assert.throws(
            () => f.call(1, 'CSReboundBulletNtfReq', { ...f.confirmation, result: 0 }),
            /Conflicting rebound confirmation/,
        )
        const duplicate = f.call(0, 'CSReboundBulletReq', f.request)
        assert.equal(pick(duplicate, 11144).length, 0)
        assert.equal(f.protocol.decode('SCReboundBulletNtf', pick(duplicate, 11146)[0].payload).result, 0)
        assert.deepEqual([f.state(0).player.sbag_infos, f.state(1).player.sbag_infos], bags)
        // Durable confirmations also deduplicate after EnterGame reconnect.
        const reconnect = {}
        const entry = f.protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(reconnect, {
            id: entry.id,
            seq: 1,
            payload: f.protocol.encode(entry.req, { open_id: 'rebound-1', reconnect: true }),
        })
        f.sessions[1] = reconnect
        assert.throws(() => f.call(1, 'CSReboundBulletNtfReq', f.confirmation), /owner connection changed/)
    } finally {
        f.store.close()
    }
})

test('unrequested results, unknown bullets, unsupported actor IDs and mismatched skill or caster cannot cast', () => {
    const f = fixture()
    try {
        assert.throws(() => f.call(0, 'CSReboundBulletNtfReq', f.confirmation), /no owner request/)
        assert.throws(
            () => f.call(0, 'CSReboundBulletReq', { ...f.request, target_id: '556' }),
            /Unknown current rebound bullet/,
        )
        assert.throws(() => f.call(0, 'CSReboundBulletReq', { ...f.request, cast_id: '999' }), /Invalid rebound caster/)
        f.offline.add(f.sessions[1].id)
        assert.throws(() => f.call(0, 'CSReboundBulletReq', f.request), /owner is offline/)
        f.offline.clear()
        f.store.transact(f.sessions[1].id, 0, (state) => {
            delete state.combat.bullets['555'].updated_at
        })
        assert.throws(() => f.call(0, 'CSReboundBulletReq', f.request), /Invalid recorded bullet timestamp/)
        f.store.transact(f.sessions[1].id, 0, (state) => {
            state.combat.bullets['555'].updated_at = 1800000000
        })
        f.call(0, 'CSReboundBulletReq', f.request)
        const before = f.state(1).combat.reboundRequests['555']
        assert.throws(() => f.call(1, 'CSReboundBulletNtfReq', { ...f.confirmation, skill_id: 999 }), /does not match/)
        assert.throws(
            () => f.call(1, 'CSReboundBulletNtfReq', { ...f.confirmation, cast_id: f.heroes[1] }),
            /does not match/,
        )
        assert.throws(
            () => f.call(1, 'CSReboundBulletNtfReq', { ...f.confirmation, result: 2 }),
            /Invalid rebound result/,
        )
        assert.deepEqual(f.state(1).combat.reboundRequests['555'], before)
    } finally {
        f.store.close()
    }
})

test('scene exit cancels pending owner confirmation and stale requests cannot create a reflected cast', () => {
    const f = fixture()
    try {
        f.call(0, 'CSReboundBulletReq', f.request)
        f.store.transact(f.sessions[0].id, 0, (state) => {
            state.world.map_id = 701
        })
        assert.equal(pick(f.call(1, 'CSReboundBulletNtfReq', f.confirmation), 11146).length, 0)
        assert.equal(f.state(1).combat.reboundRequests['555'].status, 'cancelled-after-scene-change')
        f.advance(121)
        assert.throws(() => f.call(1, 'CSReboundBulletNtfReq', f.confirmation), /expired/)
    } finally {
        f.store.close()
    }
})

test('pending owner and requester handshakes cannot execute on replacement connections after real re-login', () => {
    const f = fixture()
    const reconnect = (index) => {
        const session = {},
            entry = f.protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(session, {
            id: entry.id,
            seq: 1,
            payload: f.protocol.encode(entry.req, { open_id: `rebound-${index}`, reconnect: true }),
        })
        f.sessions[index] = session
    }
    try {
        f.call(0, 'CSReboundBulletReq', f.request)
        const pending = structuredClone(f.state(1).combat.reboundRequests['555'])
        assert.match(pending.owner_connection, /^[a-f0-9]{64}$/)
        assert.match(pending.requester_connection, /^[a-f0-9]{64}$/)
        assert(!JSON.stringify(pending).includes(f.sessions[0].token))
        const bags = [f.state(0).player.sbag_infos, f.state(1).player.sbag_infos]
        reconnect(0)
        assert.equal(
            f.state(1).combat.reboundRequests['555'].status,
            'pending',
            'login does not clear the owner pending record',
        )
        assert.equal(pick(f.call(1, 'CSReboundBulletNtfReq', f.confirmation), 11146).length, 0)
        assert.equal(f.state(1).combat.reboundRequests['555'].status, 'cancelled-requester-connection-changed')
        assert.equal(
            f.protocol.decode('SCReboundBulletNtf', pick(f.call(0, 'CSReboundBulletReq', f.request), 11146)[0].payload)
                .result,
            0,
        )
        // Open a different actual bullet handshake, then replace its owner.
        f.call(1, 'CreateBullet', {
            unit_id: f.heroes[1],
            bullet_info: [{ bullet_id: '557', config_id: 100 }],
            op_time: '1800000000050',
        })
        f.call(0, 'CSReboundBulletReq', { ...f.request, target_id: '557' })
        const before = structuredClone(f.state(1).combat.reboundRequests['557'])
        reconnect(1)
        assert.throws(
            () => f.call(1, 'CSReboundBulletNtfReq', { ...f.confirmation, target_id: '557' }),
            /owner connection changed/,
        )
        assert.deepEqual(f.state(1).combat.reboundRequests['557'], before)
        assert.deepEqual([f.state(0).player.sbag_infos, f.state(1).player.sbag_infos], bags)
    } finally {
        f.store.close()
    }
})

test('both player states roll back if target encoding or related-player SQL persistence fails', () => {
    const f = fixture()
    try {
        const baseline = [f.state(0), f.state(1)]
        const frame = f.frame('CSReboundBulletReq', f.request),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (String(type).endsWith('CSReboundBullet')) throw Error('rebound-codec')
            return encode(type, value)
        }
        assert.throws(() => f.game.dispatch(f.sessions[0], frame), /rebound-codec/)
        f.protocol.encode = encode
        assert.deepEqual([f.state(0), f.state(1)], baseline)
        f.store.db.exec(
            `CREATE TRIGGER rebound_fail BEFORE UPDATE ON players WHEN NEW.account_id=${f.sessions[1].id} BEGIN SELECT RAISE(ABORT,'rebound-sql'); END`,
        )
        assert.throws(() => f.call(0, 'CSReboundBulletReq', f.request), /rebound-sql/)
        assert.deepEqual([f.state(0), f.state(1)], baseline)
    } finally {
        f.store.db.exec('DROP TRIGGER IF EXISTS rebound_fail')
        f.store.close()
    }
})
