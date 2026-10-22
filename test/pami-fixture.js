import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { pamiMailSnapshot } from '../src/pami-mail.js'
const cfg = configuration()
export const tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
export function setup(file = ':memory:', unlocked = true) {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'pami-mail' })
    store.transact(session.id, 0, (s) => {
        grantRewards(tables, s, [{ itemtype: 1, itemid: 101010, itemnum: 1 }])
        s.player.heros_info.heros.find((h) => h.conf_id === 101010).favorability_lv = 1
        if (unlocked) (s.taskRecords ??= []).push({ task_id: 106010, count: 1 })
    })
    const login = call('EnterGame', { open_id: 'pami-mail' }, {})
    return {
        store,
        session,
        game,
        call,
        login,
        state: () => store.load(session.id).state,
        snapshot: () => pamiMailSnapshot(tables, store.load(session.id).state, now),
        now: () => now,
        advance: (n) => {
            now += n
        },
        close: () => store.close(),
    }
}
export const letters = (f) => f.snapshot().mail_tab.flatMap((t) => t.contents)
export const read = (f, id = 10681) => f.call('PamiMailRead', { u32: id })

// Explicit valid delivered-save fixture; this is NOT an automatic path through
// the current first gift, whose configured305021 item is absent in CBT3.
export function deliveredGift(f, id = 30102) {
    const row = tables.find('pami_letter_list', id),
        at = f.now() - row.time
    f.store.transact(f.session.id, 0, (s) => {
        ;(s.taskRecords ??= []).push({ task_id: 206033, count: 1 })
        s.pamiMail.letters[id] = {
            mail_id: id,
            hero_id: '0',
            timestamp: at,
            latest_read: false,
            reply: [{ text_id: row.firstId, record: 0, timestamp: at }],
            reward: [],
            args: [],
        }
        s.pamiMail.revision++
    })
    read(f, id)
}
