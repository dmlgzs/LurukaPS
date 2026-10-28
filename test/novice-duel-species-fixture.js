import assert from 'node:assert/strict'
import { noviceEventFixture } from './novice-duel-event-fixture.js'
import { grantRewards } from '../src/rewards.js'

export function noviceSpeciesFixture(name, options) {
    const f = noviceEventFixture(name, options)
    const choose = (distinct = 8) => {
        f.edit((state) => {
            const selected = []
            for (const pet of state.pets)
                if (!selected.some((old) => old.config_id === pet.config_id)) selected.push(pet)
            assert(selected.length >= 8)
            const wanted = selected.slice(0, distinct)
            if (distinct === 7) {
                const before = new Set(state.pets.map((pet) => pet.guid))
                // Legitimate inventory precondition, not a deployment/win fact.
                grantRewards(f.tables, state, [{ itemtype: 5, itemid: wanted[0].config_id, itemnum: 1 }])
                const duplicate = state.pets.find((pet) => !before.has(pet.guid))
                assert(duplicate)
                wanted.push(duplicate)
            }
            state.pets = [...wanted, ...state.pets.filter((pet) => !wanted.includes(pet))]
        })
    }
    const deploy = (limit = 8) => {
        const actors = f.actors(),
            first = actors.find((actor) => f.state().combat.npcDuel.in_fight[actor.uuid])
        assert(first)
        let current = first
        for (const actor of actors.filter((actor) => actor.uuid !== first.uuid).slice(0, limit - 1)) {
            f.advance(20)
            f.summon(actor, current)
            assert(f.state().combat.npcDuel.in_fight[actor.uuid], 'Real11810 accepted this deployment')
            current = actor
        }
        return { first, current }
    }
    return {
        ...f,
        get session() {
            return f.session
        },
        choose,
        deploy,
    }
}
