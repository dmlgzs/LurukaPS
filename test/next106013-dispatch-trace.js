import { Game } from '../src/game.js'

export function observeCurrentDispatch() {
    const guard = Symbol.for('LurukaPS.test.currentGameDispatchObserver')
    if (Game.prototype[guard]) throw Error('Concurrent Game.dispatch observation is not supported')
    const original = Game.prototype.dispatch,
        trace = []
    Game.prototype[guard] = true
    const wrapped = function (session, frame) {
        const entry = this.protocol.byId.get(frame.id)
        const row = {
            index: trace.length,
            id: frame.id,
            seq: frame.seq,
            name: entry?.name,
            request: entry?.req ? this.protocol.decode(entry.req, frame.payload) : null,
        }
        trace.push(row)
        try {
            const packets = original.call(this, session, frame)
            row.acks = packets.map((packet) => ({
                id: packet.id,
                seq: packet.seq,
                pushSeq: packet.pushSeq,
                name: this.protocol.byId.get(packet.id)?.name,
            }))
            return packets
        } catch (error) {
            row.error = { message: error.message, code: error.code }
            throw error
        }
    }
    Game.prototype.dispatch = wrapped
    let restored = false
    return {
        trace,
        restore() {
            if (restored) return
            const changed = Game.prototype.dispatch !== wrapped
            Game.prototype.dispatch = original
            delete Game.prototype[guard]
            restored = true
            if (changed) throw Error('Game.dispatch changed during observation')
        },
    }
}
