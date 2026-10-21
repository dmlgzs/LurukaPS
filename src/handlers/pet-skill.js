import { ErrorCode } from '../error-codes.js'
import { ensure, pet } from './common.js'
import { isRetiredTrialActor, temporaryPets } from '../trial-actors.js'
import { petComprehensionPlan } from '../pet-comprehension-training.js'
import { spend } from '../inventory.js'
import { petFavorPlan, applyPetFavorPlan } from '../pet-favor.js'
export function skillFailureRate(tables, state, p) {
    const suppression = p.suppress_lv ?? 0,
        force = BigInt(state.player.attr_infos.attrs.find((a) => a.attr_id === 22)?.attr_val ?? '0')
    ensure(Number.isInteger(suppression) && suppression >= 0 && force >= 0n, 'Invalid pet suppression state')
    if (BigInt(suppression) <= force) return 0
    const difference = Number(BigInt(suppression) - force),
        row = tables.get('pet_level_decay').find((r) => r.lvDif === difference)
    if (!row) return 0 // Mirrors the client's exact lvDif lookup and missing-row fallback.
    const rate =
        row[p.original_type === 1 ? 'bossSkillFail' : p.original_type === 2 ? 'eliteSkillFail' : 'normalSkillFail']
    ensure(Number.isInteger(rate) && rate >= 0 && rate <= 10000, 'Invalid pet skill failure rate', ErrorCode.GameConfig)
    return rate
}
export function registerPetSkill(on) {
    on('LvUpComprehension', (c, r) => {
        const target = c.state.pets.find((pet) => pet.guid === String(r.pet_id))
        ensure(target, 'Pet is not owned', ErrorCode.PetNotExist)
        ensure(c.tables.find('pet', target.config_id), 'Pet configuration unavailable', ErrorCode.PetConfNotExist)
        const training = petComprehensionPlan(c.tables, target, r.items ?? [])
        // Current Lua pet sync uses reason 162 to display fruit favor changes.
        const favor = petFavorPlan(c.tables, c.state, target, training.favor, 162, c.now)
        spend(c.state, training.costs, 0, c.now)
        target.comprehension = training.comprehension
        applyPetFavorPlan(c.state, target, favor)
        c.state.petRevision = (c.state.petRevision ?? 0) + 1
        return {}
    })
    on('SkillFailVec', (c, r) => {
        if (isRetiredTrialActor(c.state, r.unit_id)) return
        const p = temporaryPets(c.state).find((p) => p.guid === r.unit_id) ?? pet(c.state, r.unit_id),
            rate = skillFailureRate(c.tables, c.state, p),
            records = (c.state.petSkillRolls ??= {})
        let record = records[p.guid]
        if (!c.requestKey || record?.request_key !== c.requestKey || record.rate !== rate) {
            // The wire format leaves the batch size to the server; 32 is local policy.
            record = {
                request_key: c.requestKey,
                rate,
                success: rate === 0,
                fail_vec: rate === 0 ? [] : Array.from({ length: 32 }, () => c.randomInt(10000) < rate),
            }
            records[p.guid] = record
        }
        c.push('SCProtoSkillFailVec', { unit_id: p.guid, success: record.success, fail_vec: record.fail_vec })
    })
}
