import { achievementFixture } from './achievement-fixture.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { petSoulRow } from '../src/pet-star-soul.js'

const text = (value) => Buffer.from(String(value)).toString('base64')
export const packedSoul = (stage, node) => ((BigInt(stage) << 32n) | BigInt(node)).toString()

export function soulProgressFixture(name, count = 1, file) {
    const f = achievementFixture(name, file)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    edit((state) => {
        // Unrelated game-entry and payment prerequisites only. No star-soul
        // positions or15045 completion receipts are injected.
        state.player.basic_info.lv = 30
        state.tasks = []
        state.taskRecords = f.tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: 1799999900 }))
    })
    if (count > 1) f.call('GMCommand', { command: text('give'), args: [5, 500001, count - 1].map(text) })
    const ids = f
        .state()
        .pets.filter((pet) => pet.config_id === 500001)
        .slice(0, count)
        .map((pet) => pet.guid)
    if (ids.length !== count) throw Error('Missing real prepared pet instances')
    edit((state) => {
        const selected = new Set(ids)
        state.pets = state.pets.filter((pet) => selected.has(pet.guid))
        for (const pet of state.pets) {
            pet.is_lock = false
            pet.hero_id = '0'
            pet.roulette_pos = 0
        }
        for (const hero of state.player.heros_info.heros) hero.pet_id = '0'
        state.world.mount = '0'
        const rows = f.tables.get('pet_starsoul').filter((row) => row.templateId === 1000 && row.type !== 3)
        const costs = new Map()
        for (const row of rows) {
            for (const item of parseRewards(row.item)) {
                const key = item.itemtype + ':' + item.itemid
                const previous = costs.get(key)
                costs.set(key, { ...item, itemnum: (previous?.itemnum ?? 0) + item.itemnum * count })
            }
            if (row.kiboItemNum) {
                const itemid = f.tables.find('pet', 500001).starsoulItem,
                    key = '3:' + itemid,
                    previous = costs.get(key)
                costs.set(key, { itemtype: 3, itemid, itemnum: (previous?.itemnum ?? 0) + row.kiboItemNum * count })
            }
        }
        grantRewards(f.tables, state, [...costs.values()])
    })
    const target = (guid) => f.state().pets.find((pet) => pet.guid === guid)
    const advance = (guid, stage, node) => {
        const wanted = petSoulRow(f.tables, target(guid)).rows.findIndex(
            (row) => row.group === stage && row.node === node,
        )
        if (wanted < 0) throw Error('Target node is absent')
        let packets = []
        while (petSoulRow(f.tables, target(guid)).index < wanted)
            packets = f.call('KiboStarLinkSoulUpdate', { u64: guid })
        return packets
    }
    return { ...f, edit, ids, target, advance }
}
