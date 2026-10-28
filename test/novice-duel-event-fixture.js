import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'

export function noviceEventFixture(name, options) {
    const f = noviceDuelFixture(name, options)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    const actors = () => Object.values(f.state().combat.npcDuel.actors).filter((actor) => actor.camp === 1)
    const summon = (actor, replacement) =>
        f.call('KiboDuelArenaSummonReq', {
            pet_guid: actor.uuid,
            source_pet_guid: actor.source_guid,
            pos: f.state().combat.npcDuel.positions.selfSummon.pos,
            angle: actor.angle,
            ...(replacement ? { replace_kibo_guid: replacement.uuid } : {}),
        })
    const selectTagged = (tag) => {
        edit((s) => {
            const selected = s.pets
                .filter((p) =>
                    String(f.tables.find('pet', p.config_id).kiboDuelTag ?? '')
                        .split('|')
                        .map(Number)
                        .includes(tag),
                )
                .slice(0, 2)
            assert.equal(selected.length, 2, 'Two real current seeded pet instances share the configured tag')
            s.pets = [...selected, ...s.pets.filter((pet) => !selected.includes(pet))]
        })
    }
    return {
        ...f,
        get session() {
            return f.session
        },
        edit,
        actors,
        summon,
        selectTagged,
    }
}

export function noviceEventFile() {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'novice-events-'))
    return {
        file: path.join(dir, 'state.sqlite'),
        close() {
            const target = path.resolve(dir)
            assert.equal(path.dirname(target), parent)
            assert(path.basename(target).startsWith('novice-events-'))
            fs.rmSync(target, { recursive: true, force: true })
        },
    }
}
