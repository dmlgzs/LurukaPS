import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards } from '../src/rewards.js'
import { journeyModel, journeyLedger, journeyPoints } from '../src/journey.js'

export function selectionDefinition(tables) {
    const rows = tables.get('journey_point_reward').filter((r) => r.isBigReward)
    assert.equal(rows.length, 1)
    const row = rows[0],
        source = parseRewards(row.reward)
    assert.equal(source.length, 1)
    assert.equal(source[0].itemtype, 3)
    assert.equal(source[0].itemnum, 1)
    const box = tables.find('common_item', source[0].itemid)
    assert(box)
    return {
        row,
        box,
        choices: parseRewards(box.giftBagReward),
        bit: 2 ** tables.get('journey_point_reward').indexOf(row),
    }
}
export function trustedClaimedPoints(f, wanted = selectionDefinition(f.tables).row.point) {
    // EXPLICIT TRUSTED SAVE BOUNDARY ONLY. This builds already-paid target
    // receipts, never a numeric point override. It is not a natural earning E2E
    // or proof that every target's event producer has been implemented.
    const model = journeyModel(f.tables),
        ways = Array(wanted + 1).fill(null)
    ways[0] = []
    for (const r of model.targets.filter((r) => model.owner.has(r.id) && r.completePoint > 0))
        for (let n = wanted; n >= r.completePoint; n--)
            if (!ways[n] && ways[n - r.completePoint]) ways[n] = [...ways[n - r.completePoint], r]
    assert(ways[wanted], 'current active-target point values must represent this boundary')
    f.edit((s) => {
        const ledger = journeyLedger(s)
        assert.equal(journeyPoints(model, s), 0, 'trusted boundary fixture starts before any real point claim')
        for (const r of ways[wanted]) ledger.targets[r.id] = { value: r.targetParam, complete: true, claimed: true }
        ledger.claimRevision++
        assert.equal(journeyPoints(model, s), wanted)
    })
    return ways[wanted].map((r) => r.id)
}
export function fixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, gmEnabled: true })
    let session = {},
        seq = 1,
        last = []
    const open_id = 'journey-current-' + name
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (request, who = session) => {
        last = game.dispatch(who, request)
        const e = protocol.byId.get(request.id)
        return e.rsp ? protocol.decode(e.rsp, last.find((p) => p.id === request.id).payload) : undefined
    }
    const call = (name, data) => dispatch(frame(name, data))
    const login = () => {
        const next = {}
        dispatch(frame('EnterGame', { open_id }), next)
        session = next
        return last
    }
    login()
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        frame,
        dispatch,
        call,
        login,
        get session() {
            return session
        },
        packets: () => last,
        state: () => store.load(session.id).state,
        saved: () => store.load(session.id),
        edit: (fn) => store.transact(session.id, 0, fn),
        gm: (cmd) => call('GMCommand', { command: Buffer.from(cmd).toString('base64') }),
        close: () => store.close(),
    }
}
