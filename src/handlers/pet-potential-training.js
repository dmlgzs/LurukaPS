import { createHash } from 'node:crypto'
import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import {
    potentialTrainingRequest,
    petPotentialTrainingPlan,
    selectPetPotentialOutcome,
    validatePetPotentialPolicy,
} from '../pet-potential-training.js'
import { spend } from '../inventory.js'
import { grantRewards } from '../rewards.js'
import { petReleaseRewards, releaseBonus } from '../pet-release.js'
import { releaseLedger } from '../release-ledger.js'
import { initializePetStarSoulProgress } from '../pet-star-soul-progress.js'
import { petReleaseColorRewards } from '../pet-release-colors.js'

const hash = (value) => createHash('sha256').update(value).digest('hex')
export function registerPetPotentialTraining(on, tables) {
    const policy = validatePetPotentialPolicy(),
        hour = Number(tables.get('game').find((row) => row.title === 'DAILY_REFRESH_TIME')?.value)
    ensure(
        Number.isInteger(hour) && hour >= 0 && hour < 24,
        'Potential training release day is malformed',
        ErrorCode.PetTrainConfig,
    )
    on('KiboTrain', (c, raw) => {
        const request = potentialTrainingRequest(raw),
            payloadHash = hash(JSON.stringify(request)),
            key = c.requestKey ? hash(c.requestKey) : null,
            receipts = c.state.petPotentialTrainReceipts ?? []
        ensure(
            Array.isArray(receipts) &&
                receipts.length <= policy.receiptLimit &&
                receipts.every(
                    (row) =>
                        row?.version === 1 &&
                        /^[a-f0-9]{64}$/.test(row.key) &&
                        /^[a-f0-9]{64}$/.test(row.payloadHash) &&
                        row.response?.is_success === true &&
                        Array.isArray(row.response.reward?.rewards),
                ),
            'Malformed potential training receipt ledger',
            ErrorCode.GameConfig,
        )
        ensure(
            new Set(receipts.map((row) => row.key)).size === receipts.length,
            'Duplicate potential training receipts',
            ErrorCode.GameConfig,
        )
        const previous = key && receipts.find((row) => row.key === key)
        if (previous) {
            ensure(
                previous.payloadHash === payloadHash,
                'Potential training sequence reused with different input',
                ErrorCode.InvalidPacket,
            )
            return structuredClone(previous.response)
        }
        const plan = petPotentialTrainingPlan(c, request),
            ledger = releaseLedger(c.state, 'pet', c.now, hour),
            refund = petReleaseRewards(tables, plan.partner),
            rewards = [
                ...refund.rewards,
                ...releaseBonus(tables, 'pet', ledger, refund.bonusEligible ? 1 : 0),
                ...petReleaseColorRewards(tables, plan.partner, c.randomInt, policy),
            ]
        spend(c.state, plan.costs, 0, c.now)
        const level = selectPetPotentialOutcome(plan, c.randomInt),
            value = plan.curve[level - 1].InterA
        initializePetStarSoulProgress(tables, c.state)
        const granted = grantRewards(tables, c.state, rewards)
        plan.target.comprehension = plan.target.comprehension.map((row) =>
            row.attr_id === request.choose_type
                ? { ...row, level, value, cur_exp: level === plan.cap ? 0 : (row.cur_exp ?? 0) }
                : row,
        )
        plan.removePartner()
        ledger.lastTime = c.now
        c.state.releaseLedgers ??= {}
        c.state.releaseLedgers.pet = ledger
        const response = { is_success: true, reward: { rewards: granted } }
        if (key)
            c.state.petPotentialTrainReceipts = [
                ...receipts,
                {
                    version: 1,
                    key,
                    payloadHash,
                    policyId: policy.policyId,
                    trainPet: request.train_pet,
                    partnerPet: request.partner_train_pet,
                    attribute: request.choose_type,
                    previousLevel: plan.current.level,
                    level,
                    time: c.now,
                    response: structuredClone(response),
                },
            ].slice(-policy.receiptLimit)
        // Existing Game petRevision observer emits 6517 (including deletion
        // GUIDs and releaseFields) and derived 10006 before the request ACK.
        return response
    })
}
