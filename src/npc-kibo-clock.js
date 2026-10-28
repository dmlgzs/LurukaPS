import { ErrorCode } from './error-codes.js'
import { arenaContext, arenaMillis, arenaActionMillis, secondsToArenaMs } from './npc-kibo-time.js'
import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'
import { arenaFeverInfo } from './npc-kibo-stage-buffs.js'
import { arenaScoreOutcome, sealArenaScoreOutcome } from './npc-kibo-outcome-time.js'

// Local wire cadence, not an official backend rate. Keep a stable window
// beyond ModuleDuelEnergy's350ms CostInit callback between passive updates.
const ACTION_POINT_UI_SYNC_MS = 500

export function arenaTiming(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId),
        cost = pairs(duel.cost)
    const initial = cost.get(307),
        max = cost.get(305),
        interval = cost.get(306)
    ensure(
        initial >= 0 && max >= initial && interval > 0,
        'Arena action point configuration unavailable',
        ErrorCode.GameConfig,
    )
    const schedule = [
        { at: 0, interval },
        ...String(duel.costTime || '')
            .split('|')
            .filter(Boolean)
            .map((text) => {
                const [at, interval] = text.split('#').map(Number)
                ensure(at >= 0 && interval > 0, 'Invalid arena recovery schedule', ErrorCode.GameConfig)
                return { at, interval }
            }),
    ].sort((a, b) => a.at - b.at)
    const gcd = Number(tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_GCD')?.value)
    ensure(gcd >= 0, 'Arena global cooldown configuration unavailable', ErrorCode.GameConfig)
    return { initial: initial * 100, max: max * 100, schedule, gcd }
}

export function startArenaClock(c) {
    c = arenaContext(c)
    const battle = c.state.combat,
        run = battle.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    if (run.regular_started_at !== undefined) return
    const energy = { points: timing.initial, at: c.now }
    battle.npcDuel = {
        ...run,
        regular_started_at: c.now,
        end_at: c.now + Number(c.tables.find('kibo_duel', run.duel_id).time),
        score_at: c.now,
        energy: { 1: { ...energy }, 2: { ...energy } },
        gcd_until: { 1: 0, 2: 0 },
    }
}

export function advanceArenaScores(c) {
    c = arenaContext(c)
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (
        !run ||
        run.pause ||
        run.regular_started_at === undefined ||
        run.result ||
        arenaScoreOutcome(run) ||
        run.score_at >= c.now
    )
        return false
    const counts = { 1: 0, 2: 0 }
    // Membership describes the interval before a summon/death at this instant.
    for (const uuid of Object.keys(run.in_fight)) counts[run.actors[uuid].camp]++
    const empty = counts[1] > 0 && counts[2] === 0 ? 2 : counts[2] > 0 && counts[1] === 0 ? 1 : 0
    const rates = String(
        c.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_SCORE_VELOCITY')?.value ?? '',
    )
        .split('|')
        .filter(Boolean)
        .map((text) => {
            const [at, rate] = text.split('#').map(Number)
            return { at, rate }
        })
        .sort((a, b) => a.at - b.at)
    ensure(
        rates.length && rates.every((row) => row.at >= 0 && row.rate >= 0),
        'Arena score rate unavailable',
        ErrorCode.GameConfig,
    )
    let loss = 0,
        zeroAtMs
    const needed = empty ? run.scores[empty] * 1000 - (run.score_remainders?.[empty] ?? 0) : 0
    if (empty)
        for (let i = 0; i < rates.length; i++) {
            const start = Math.max(run.score_at, run.regular_started_at + rates[i].at)
            const end = Math.min(c.now, run.end_at, run.regular_started_at + (rates[i + 1]?.at ?? Infinity))
            if (end > start) {
                const fromMs = secondsToArenaMs(start),
                    toMs = secondsToArenaMs(end),
                    amount = (toMs - fromMs) * rates[i].rate
                if (zeroAtMs === undefined && run.scores[empty] > 0 && rates[i].rate > 0 && loss + amount >= needed)
                    zeroAtMs = fromMs + Math.ceil((needed - loss) / rates[i].rate)
                loss += amount
            }
        }
    const scores = { ...run.scores }
    const fractions = { ...run.score_remainders }
    let lost = 0
    if (empty) {
        const total = loss + (fractions[empty] ?? 0)
        lost = Math.floor(total / 1000)
        fractions[empty] = total - lost * 1000
        scores[empty] = Math.max(0, scores[empty] - lost)
    }
    let next = { ...run, score_at: Math.min(c.now, run.end_at), scores, score_remainders: fractions }
    if (zeroAtMs !== undefined) next = sealArenaScoreOutcome(next, zeroAtMs, scores, 'passive')
    battle.npcDuel = next
    if (lost)
        c.push('SCProtoKiboDuelArenaScoreInfoSync', {
            score_infos: [1, 2].map((camp) => ({ camp, score: scores[camp] })),
        })
    return lost > 0
}

export function advanceArenaEnergy(c) {
    c = arenaContext(c)
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (!run?.energy || run.pause || run.result) return false
    const timing = arenaTiming(c.tables, run.duel_id)
    const energy = {},
        effects = run.trainer_effects ?? []
    let changed = false
    for (const camp of [1, 2]) {
        const previous = run.energy[camp]
        let points = previous.points,
            from = previous.at,
            to = Math.min(c.now, run.end_at)
        const fromMs = secondsToArenaMs(from),
            toMs = secondsToArenaMs(to)
        const events = effects.filter((effect) => effect.camp === camp)
        const boundaries = [
            ...new Set(
                [
                    fromMs,
                    toMs,
                    ...timing.schedule.map((segment) => secondsToArenaMs(run.regular_started_at + segment.at)),
                    ...events.flatMap((effect) => [effect.at_ms, effect.at_ms + (effect.duration_ms ?? 0)]),
                ].filter((at) => at >= fromMs && at <= toMs),
            ),
        ].sort((a, b) => a - b)
        for (let i = 1; i < boundaries.length; i++) {
            const start = boundaries[i - 1],
                end = boundaries[i],
                middle = (start + end) / 2
            const segment = timing.schedule.findLast(
                (item) => secondsToArenaMs(run.regular_started_at + item.at) <= middle,
            )
            const percent = events
                .filter(
                    (effect) =>
                        effect.kind === 'interval_percent' &&
                        effect.at_ms <= middle &&
                        effect.at_ms + effect.duration_ms > middle,
                )
                .reduce((sum, effect) => sum + effect.value, 0)
            ensure(1 + percent > 0, 'Invalid arena action point recovery modifier', ErrorCode.GameConfig)
            points = Math.min(timing.max, points + (end - start) / (10 * segment.interval * (1 + percent)))
            for (const effect of events)
                if (effect.kind === 'points' && effect.at_ms === end && effect.at_ms > fromMs)
                    points = Math.max(0, Math.min(timing.max, points + effect.value * 100))
        }
        energy[camp] = { points, at: Math.max(previous.at, to) }
        if (energy[camp].at !== previous.at || points !== previous.points) changed = true
    }
    const settled = secondsToArenaMs(Math.min(energy[1].at, energy[2].at))
    const pending = effects.filter((effect) => effect.at_ms + (effect.duration_ms ?? 0) > settled)
    if (changed || pending.length !== effects.length)
        battle.npcDuel = { ...run, energy, ...(effects.length ? { trainer_effects: pending } : {}) }
    return changed
}

export function arenaCostStage(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (!run || run.regular_started_at === undefined || run.result) return false
    const elapsed = (run.pause?.server_at ?? c.now) - run.regular_started_at
    // Native UpdateRecoverSpeed uses battleTime > costTime[n][0]. The UI's
    // event7 selects costTime[0][1]; event6/in_speed_stage is separate Fever.
    return arenaTiming(c.tables, run.duel_id)
        .schedule.slice(1)
        .some((segment) => elapsed > segment.at)
}

export function publishArenaCostStage(c) {
    c = arenaContext(c)
    const run = c.state.combat?.npcDuel
    if (
        !run ||
        c.state.multiCampaign?.arena_status !== 4 ||
        run.map_id !== c.state.world.map_id ||
        !run.entities_sent ||
        c.state.kiboDuelLoadingCompleteAt === undefined ||
        run.cost_stage_sent ||
        !arenaCostStage(c)
    )
        return
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
        status: 4,
        status_endtime: String(Math.ceil(run.end_at)),
        enter_type: 0,
        cost_change: true,
        ...arenaFeverInfo(c),
    })
    // Repeating true restarts native StartCostRecover. Replay only after an
    // entity/UI rebuild or through the explicit pause-resume snapshot.
    c.state.combat.npcDuel = { ...run, cost_stage_sent: true }
    publishArenaEnergy(c)
}

export function arenaHand(state) {
    const run = state.combat.npcDuel
    return {
        pet_guids: Object.values(run.actors)
            .filter(
                (actor) => actor.camp === 1 && !run.in_fight[actor.uuid] && state.combat.entities[actor.uuid]?.hp > 0,
            )
            .map((actor) => actor.source_guid),
        global_cd_endtime: String(run.gcd_until?.[1] ?? 0),
    }
}

export function publishArenaEnergy(c, force = true) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    if (!run.energy) return
    const current = Math.floor(run.energy[1].points + 1e-7)
    // OnMainUIShow can clear Filled after the first count packet. Whole-point
    // updates alone then leave that cell dark. Send changed fractional values
    // too, coalesced so the native animation can finish. Do not fabricate a
    //0→1 transition or resend unchanged values. Whole-point/capacity changes
    // and explicit consumption/pause corrections stay immediate.
    const marker = `${current}:${timing.max}`,
        whole = `${Math.floor(current / 100)}:${timing.max}`,
        now = arenaMillis(c)
    if (
        !force &&
        (run.energy_sent === marker ||
            (run.energy_sent_whole === whole && now - (run.energy_sync_at ?? -Infinity) < ACTION_POINT_UI_SYNC_MS))
    )
        return
    c.pushBefore('SCProtoKiboDuelArenaActionPointSync', {
        current_points: current,
        max_points: timing.max,
        next_recover_time: '0',
    })
    c.state.combat.npcDuel = {
        ...c.state.combat.npcDuel,
        energy_sent: marker,
        energy_sent_whole: whole,
        energy_sync_at: now,
    }
}

export function consumeArenaPoint(c, camp) {
    c = arenaContext(c)
    advanceArenaEnergy(c)
    const battle = c.state.combat,
        run = battle.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    // A guide pauses the world while waiting for the player's deployment ACK.
    // It does not make that input invalid or allow NPC simulation to advance.
    ensure(!run.pause || camp === 1, 'Arena is paused', ErrorCode.PlayerInPause)
    const now = arenaActionMillis(c)
    ensure(
        run.energy?.[camp].points >= 100 - 1e-7,
        'Not enough arena action points',
        ErrorCode.KiboDuelArenaPointNotEnough,
    )
    ensure(now >= (run.gcd_until?.[camp] ?? 0), 'Arena summon is cooling down', ErrorCode.KiboDuelArenaGlobalCd)
    battle.npcDuel = {
        ...run,
        energy: { ...run.energy, [camp]: { ...run.energy[camp], points: Math.max(0, run.energy[camp].points - 100) } },
        gcd_until: { ...run.gcd_until, [camp]: now + timing.gcd },
    }
}
