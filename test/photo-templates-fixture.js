import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const config = configuration()
export const tables = new Tables(config.tables)
export const fullArguments =
    'setting_{extStrTb|1008|0|1009|1}$time_{val|0.000}$filter_{val|401.000}_{sliderValue|1.000}$ik_{v3Val|2|2|3}$player_{val|109001.000}_{v3Val|0|350|0}$action_{val|502.000}_{sliderValue|0.505}$parm_{extStrTb|801|60.0|802|0}$color_{extStrTb|704|-0.64317321777344|705|0.073232173919678}$wind_{val|0.020}_{v3Val|0|0|0}$camera_{extStrTb|1.5999999046326|-167.21873474121|12.98127746582|0.33160096406937|0.5209584236145}$lightSetting_{extStrTb|1|0.5|0|1.2}$lightParam_{extStrTb|1-0.5|2--0.25}'
export function photoFixture(file = ':memory:') {
    const p = new Protocol(config.base),
        store = new Store(file),
        game = new Game(p, store, tables, { clock: () => 1800000000 })
    const account = store.login('photo-a', (id, open) => seedPlayer(tables, id, open)),
        other = store.login('photo-b', (id, open) => seedPlayer(tables, id, open)),
        session = { id: account.id, token: 'photo-a' }
    let seq = 1
    const call = (name, r = {}, actor = session) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(actor, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((v) => ({ id: v.id, data: p.decode(p.byId.get(v.id).rsp, v.payload) }))
    }
    call('EnterGame', { open_id: 'photo-a' }, session)
    call('EnterGame', { open_id: 'photo-b' }, { id: other.id })
    const data = (id = 1001, name = '清晨的夏露露村') => ({
        id,
        name,
        url: Buffer.from(id + '_cellBg_' + session.id).toString('base64'),
        arg: fullArguments,
    })
    return {
        p,
        store,
        game,
        session,
        other,
        call,
        data,
        save: (row = data()) => call('ChangePhotoGraphTempletInfo', row),
        state: () => store.load(session.id).state,
    }
}
export function assertFailure(f, run, code, assert) {
    const state = f.state(),
        writes = f.store.db.prepare('select total_changes() n').get().n
    assert.throws(run, (e) => e.code === code)
    assert.deepEqual(f.state(), state)
    assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
}
