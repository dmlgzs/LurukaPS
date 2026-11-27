import assert from 'node:assert/strict'
import { seedPlayer, heroData } from '../src/player.js'

export function giveCurrentHero(call, id) {
    call('GMCommand', { command: Buffer.from(`give 1 ${id} 1`).toString('base64') })
}

// Pure table/helper tests only. This explicitly builds each current usable
// hero's independent data, not a default account or sandbox reward policy.
export function heroCatalogState(tables, id, name) {
    const state = seedPlayer(tables, id, name)
    assert.equal(state.starterProfile.mode, 'normal')
    const definitions = tables.get('hero').filter((row) => row.isUsable === 1)
    assert(definitions.length > 0)
    state.player.heros_info.heros = definitions.map((row) => heroData(row.id, id))
    return state
}
