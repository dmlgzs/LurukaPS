import { heroModules, petModules } from './battle.js'
import { temporaryHeroes } from './trial-actors.js'
import { petHandbookAttributes, takePetHandbookSync, recordHandbookSkill } from './pet-handbook.js'

export function syncHandbookAttributes(c, previous) {
    if (previous === c.state.petHandbookBonuses) return
    const selected = c.state.pets.filter(
        (pet) =>
            pet.type !== 2 &&
            JSON.stringify([
                ...petHandbookAttributes(c.tables, c.state, pet, previous ?? { own: {}, elements: {} }),
            ]) !== JSON.stringify([...petHandbookAttributes(c.tables, c.state, pet)]),
    )
    if (!selected.length) return
    const heroes = [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].map((h) =>
        heroModules(c.tables, c.state, h),
    )
    c.pushBefore('CSProtoHeroAttrInfoSync', { heros: selected.map((p) => petModules(c.tables, c.state, p, heroes)) })
    if (c.state.combat) {
        delete c.state.combat.energySpecs
        delete c.state.combat.energyActorKey
    }
}
export function recordAndSyncHandbookSkill(c, pet, request) {
    const previous = c.state.petHandbookBonuses
    if (!recordHandbookSkill(c, pet, request)) return
    const payload = takePetHandbookSync(c.state)
    if (payload) c.pushBefore('CSProtoPetHandbookInfoSync', payload)
    syncHandbookAttributes(c, previous)
}
