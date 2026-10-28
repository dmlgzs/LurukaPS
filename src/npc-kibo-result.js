import { ErrorCode } from './error-codes.js'
import { recordNoviceDuelVictory } from './novice-duel-victory.js'
import { arenaContext } from './npc-kibo-time.js'
import { advanceArenaScores } from './npc-kibo-clock.js'
import { stopArenaPetAI } from './npc-kibo-pet-ai.js'
import { publishArenaStatistics } from './npc-kibo-statistics.js'
import { ensure, syncPlayer, syncPets } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { WorldObjectCatalog } from './world-objects.js'
import { refreshTaskProgress } from './tasks.js'
import { duelProgressSnapshot } from './kibo-duel-progress.js'
import { rewardSource } from './reward-source.js'
import { selectedArenaGroup } from './npc-kibo-duel.js'
import { withoutArenaOrigins } from './npc-kibo-origins.js'
import { clearArenaStageBuffs } from './npc-kibo-stage-buffs.js'

export function npcArenaOutcome(state, now) {
    const run = state.combat?.npcDuel
    if (!run || run.result || state.multiCampaign?.arena_status !== 4) return null
    if (run.scores[1] <= 0 && run.scores[2] <= 0) return { result: 3, reason: 1 }
    if (run.scores[2] <= 0) return { result: 1, reason: 1 }
    if (run.scores[1] <= 0) return { result: 2, reason: 1 }
    // CBT3 guide_words: at timeout the side with more remaining points wins.
    if (!run.pause && run.end_at && now >= run.end_at)
        return { result: run.scores[1] === run.scores[2] ? 3 : run.scores[1] > run.scores[2] ? 1 : 2, reason: 2 }
    return null
}

function notifyProgress(c) {
    c.pushBefore('CSProtoKiboDuelGroupInfoSync', {
        records: Object.values(c.state.kiboDuelRecords ?? {}),
        ...duelProgressSnapshot(c.tables, c.state),
    })
    const changed = refreshTaskProgress(c.tables, c.state)
    if (changed.length) c.pushBefore('CSProtoTaskSync', { tasks: changed })
}

function grant(c, rewards, guids) {
    const context = { petGuids: guids, petExpChanges: [] }
    const granted = grantRewards(c.tables, c.state, rewards, 0, context)
    const changes = new Map()
    for (const info of context.petExpChanges) {
        const first = changes.get(info.pet_guid)
        changes.set(info.pet_guid, first ? { ...info, old_lv: first.old_lv, old_exp: first.old_exp } : info)
    }
    syncPlayer({ ...c, push: c.pushBefore })
    if (context.petExpChanges.length || granted.some((row) => [5, 30].includes(row.itemtype)))
        syncPets({ ...c, push: c.pushBefore })
    if (changes.size) c.pushBefore('CSProtoLvUpPetSync', { infos: [...changes.values()] })
    return { rewards: granted, pet_exp: [...changes.values()] }
}

export function settleNpcArena(c, outcome) {
    c = arenaContext(c)
    advanceArenaScores(c)
    outcome ??= npcArenaOutcome(c.state, c.now)
    if (c.memoryDraft && outcome?.result === 1) Object.assign(c.state, structuredClone(c.state))
    const run = c.state.combat?.npcDuel
    ensure(run && run.map_id === c.state.world.map_id, 'No active NPC arena')
    if (run.result) return run.result
    ensure(outcome && [1, 2, 3].includes(outcome.result), 'NPC arena result is not proven')
    publishArenaStatistics(c, true)
    const duel = c.tables.find('kibo_duel', run.duel_id)
    const activeNow = run.pause?.server_at ?? c.now
    const elapsed = Math.max(0, activeNow - (run.regular_started_at ?? activeNow))
    const remaining = Math.max(0, Number(duel.time) - elapsed)
    const old = c.state.kiboDuelRecords?.[duel.id]
    const first = outcome.result === 1 && !(Number(old?.success_time) > 0)
    let mask = 0,
        granted = { rewards: [], pet_exp: [] }
    const goals = String(duel.challenge || '')
        .split('|')
        .filter(Boolean)
    if (outcome.result === 1) {
        goals.forEach((text, index) => {
            const [kind, seconds] = text.split('#').map(Number)
            ensure(
                kind === 50001 && Number.isFinite(seconds),
                'NPC duel challenge rule unavailable',
                ErrorCode.GameConfig,
            )
            if (remaining >= seconds) mask |= 1 << index
        })
        recordNoviceDuelVictory(c, duel, mask)
        const previousMask = c.state.kiboDuelChallengeClaims?.[duel.id] ?? old?.star ?? 0
        const newMask = mask & ~previousMask
        // firstLoot is first-clear bonus; commonReward is the configured
        // repeatable victory reward. Never award either on loss/surrender.
        const rewards = [...parseRewards(duel.commonReward), ...(first ? parseRewards(duel.firstLoot) : [])]
        const drops = new WorldObjectCatalog(c.tables)
        const tiers = String(duel.challengeReward || '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(tiers.length === goals.length, 'NPC challenge reward mapping unavailable', ErrorCode.GameConfig)
        tiers.forEach((drop, index) => {
            if (newMask & (1 << index)) rewards.push(...drops.drops(drop, c.randomInt))
        })
        granted = grant(
            c,
            rewards,
            Object.values(run.actors)
                .filter((actor) => actor.camp === 1)
                .map((actor) => actor.source_guid),
        )
        ;(c.state.kiboDuelRecords ??= {})[duel.id] = {
            id: duel.id,
            star: (old?.star ?? 0) | mask,
            success_time: Number(old?.success_time) > 0 ? old.success_time : String(Math.floor(c.now)),
        }
        ;(c.state.kiboDuelChallengeClaims ??= {})[duel.id] = previousMask | mask
        notifyProgress(c)
    }
    const result = {
        ...outcome,
        star: mask,
        clearance_time: String(Math.ceil(remaining)),
        is_first: first,
        is_competition: false,
    }
    const settlementSeconds = Number(
        c.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_SETTLEMENT_TIME')?.value,
    )
    ensure(settlementSeconds > 0, 'NPC settlement duration unavailable', ErrorCode.GameConfig)
    stopArenaPetAI(c)
    clearArenaStageBuffs(c)
    c.state.combat.npcDuel = {
        ...withoutArenaOrigins(c.state.combat.npcDuel),
        pet_ai: c.state.combat.npcDuel.pet_ai,
        result,
        pause: undefined,
        finished_at: c.now,
        exit_at: c.now + settlementSeconds,
        reward_receipt: { ...granted, src: rewardSource(c.tables, 'kiboDuelComplete') },
    }
    c.state.multiCampaign.arena_status = 5
    c.pushBefore('CSProtoKiboDuelFightingInfoSync', {
        id: duel.id,
        status: 4,
        star: mask,
        start_time: Math.floor(c.now - elapsed),
        end_time: Math.floor(c.now),
    })
    // Result must arrive before FINISH/EXIT: ExitStage dereferences it.
    c.pushBefore('SCProtoKiboDuelArenaResultInfoSync', result)
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
        status: 5,
        status_endtime: String(Math.ceil(c.now + settlementSeconds)),
        enter_type: 0,
    })
    return result
}

export function registerNpcArenaResults(on, tables) {
    on('KiboDuelBattleFinish', (c) => {
        c = arenaContext(c)
        // Client status/time are telemetry, not proof of a victory.
        settleNpcArena(c)
        return {}
    })
    on('KiboDuelSurrender', (c) => {
        c = arenaContext(c)
        settleNpcArena(c, { result: 2, reason: 3 })
        return {}
    })
    on('KiboRealStart', (c) => {
        c = arenaContext(c)
        ensure(
            (c.state.combat?.npcDuel?.regular_started_at && c.state.multiCampaign?.arena_status === 4) ||
                (c.state.multiCampaign?.arena_status === 6 && c.state.kiboDuelFirstConfirmedAt),
            'Arena first selection is not complete',
        )
        return {}
    })
    on('KiboDuelGetAreaReward', (c, r) => {
        c = arenaContext(c)
        const area = c.state.kiboDuelAreas?.[r.area]
        const row = tables
            .get('kibo_duel_area_level')
            .find((level) => level.areaType === r.area && level.level === r.lvl)
        ensure(row && area && area.lvl >= r.lvl, 'Duel area reward is locked')
        const src = rewardSource(tables, 'kiboDuelArea')
        if (area.got_lvl_reward.includes(r.lvl)) return { rewards: [], src }
        const group = selectedArenaGroup(c.state)
        const result = grant(
            c,
            parseRewards(row.reward),
            (group?.pet_guids ?? []).filter((pet) => !pet.is_trial).map((pet) => pet.id),
        )
        area.got_lvl_reward.push(r.lvl)
        notifyProgress(c)
        return { rewards: result.rewards, src }
    })
}
