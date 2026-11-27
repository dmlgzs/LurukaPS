import { rescueFixture } from './actor-rescue-fixture.js'
import { addItems } from '../src/inventory.js'
import {
    medicineDraft,
    medicineContext,
    trackMedicineTarget,
    registerPersonalBuffSource,
} from '../src/medicine-state.js'
export function medicineFixture(name, filename) {
    const f = rescueFixture(name, filename)
    // This three-person medicine fixture explicitly acquires only two current
    // roles; production normal starters still own only their protagonist.
    for (const id of [107002, 108002]) {
        if (!f.state().player.heros_info.heros.some((hero) => hero.conf_id === id))
            f.call('GMCommand', { command: Buffer.from(`give 1 ${id} 1`).toString('base64') })
    }
    f.heroes.splice(
        0,
        f.heroes.length,
        ...f
            .state()
            .player.heros_info.heros.slice(0, 3)
            .map((hero) => hero.guid),
    )
    if (f.heroes.length !== 3) throw Error('Medicine fixture requires three current owned roles')
    f.call('QuickChangeGroupInfo', { type: 1, id: 1, infos: f.heroes.map((hero_guid) => ({ hero_guid })) })
    let now = 1800000000
    f.game.clock = () => now
    f.time = (value) => {
        now = value
    }
    f.now = () => now
    f.store.transact(f.session.id, 0, (state) => {
        if (!state.medicine)
            addItems(state, [
                { itemid: 2020001, itemnum: 5 },
                { itemid: 2020002, itemnum: 5 },
            ])
    })
    f.dead = (id = f.heroes[0], alive = 1) =>
        f.store.transact(f.session.id, 0, (state) => {
            Object.assign(
                state.player.heros_info.battle_infos.find((row) => row.hero_id === id),
                { hp: 0, alive_state: alive, sp: 7 },
            )
        })
    f.seed = (ids = [f.heroes[0]]) =>
        f.store.transact(f.session.id, 0, (state) => {
            const ledger = medicineDraft(state),
                receipt = {
                    id: '1',
                    itemId: 2020001,
                    quantity: 1,
                    acceptedAt: now,
                    expire: now + 1800,
                    cooldownType: 19,
                    worldBuffId: 7001,
                    context: medicineContext(state),
                    status: 'open',
                    costSlices: [{ guid: '1', itemId: 2020001, quantity: 1, deadtime: 0 }],
                    targets: [],
                }
            ledger.nextReceipt = '1'
            for (const id of ids) {
                const saved = state.player.heros_info.battle_infos.find((row) => row.hero_id === id),
                    track = trackMedicineTarget(state, id, saved, '1', receipt.targets.length),
                    buffGuid = 100 + receipt.targets.length
                receipt.targets.push({
                    actorUuid: id,
                    lifeToken: track.lifeToken,
                    deathGeneration: track.deathGeneration,
                    buffGuid,
                    elementConfigId: 601400111,
                    status: 'pending',
                })
            }
            const next = medicineDraft(state)
            next.receipts = { ...next.receipts, 1: receipt }
            next.cooldowns = { ...next.cooldowns, 19: { expire: receipt.expire, receipt: '1' } }
            next.issued = { ...next.issued }
            for (const target of receipt.targets) {
                next.issued[target.buffGuid] = { actorUuid: target.actorUuid, elementConfigId: target.elementConfigId }
                registerPersonalBuffSource(
                    state,
                    f.tables,
                    { guid: target.buffGuid, buff_id: 7001, target_id: target.actorUuid },
                    'medicine',
                )
            }
        })
    f.buffs = (packets) =>
        packets
            .filter((packet) => packet.id === 9131)
            .map((packet) => f.protocol.decode('CSWordBuffSync', packet.payload))
    f.cds = (packets) =>
        packets
            .filter((packet) => packet.id === 11255)
            .map((packet) => f.protocol.decode('SCMedicineInfoSync', packet.payload))
    return f
}
