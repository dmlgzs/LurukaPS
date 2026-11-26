import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const MAX_U64 = (1n << 64n) - 1n
export function u64(value) {
    const s = String(value ?? '0')
    ensure(/^\d+$/.test(s) && BigInt(s) <= MAX_U64, 'Invalid uint64')
    return BigInt(s).toString()
}
// BattleVerifyInfo.source_id is int64, unlike its unsigned sequence IDs.
export function i64(value) {
    const s = String(value ?? '0')
    ensure(
        /^-?\d+$/.test(s) &&
            (typeof value !== 'number' || Number.isSafeInteger(value)) &&
            BigInt(s) >= -(1n << 63n) &&
            BigInt(s) < 1n << 63n,
        'Invalid int64',
    )
    return BigInt(s).toString()
}
// Request-side inverse of current1.0 BattleService.Add*/SendBattleInfoDatas
// (IL06000694..06000697); IDs and request-relative timestamps are distinct.
export function expandBattleReport(request) {
    const dictionary = request.uint64_dic ?? [],
        rows = request.battle_info ?? []
    ensure(dictionary.length <= 4096 && rows.length <= 1024, 'Battle report exceeds limits')
    const ids = dictionary.map(u64),
        base = BigInt(u64(request.base_time))
    const lookup = (value, small = false) => {
        const index = BigInt(u64(value))
        ensure(index <= BigInt(ids.length), 'Battle dictionary index outside packet')
        const id = index === 0n ? '0' : ids[Number(index) - 1]
        return small ? Number(BigInt(id) & 0xffffffffn) : id
    }
    const verify = (v) => {
        if (!v) return
        if (v.related_index !== undefined) v.related_index = lookup(v.related_index)
        v.op_time = BigInt.asUintN(64, base - BigInt(u64(v.op_time))).toString()
    }
    return rows.map((raw) => {
        const row = structuredClone(raw)
        ensure(
            [row.hurt_info, row.element_info, row.attr_change].filter(Boolean).length === 1,
            'Battle row must contain exactly one event',
        )
        if (row.hurt_info) {
            const h = row.hurt_info
            h.from_id = lookup(h.from_id)
            h.tar_id = lookup(h.tar_id)
            if (h.skill_id !== undefined) h.skill_id = lookup(h.skill_id, true)
            if (h.element_uniqueId !== undefined) h.element_uniqueId = lookup(h.element_uniqueId)
            verify(h.verify_info)
        }
        if (row.element_info) {
            const e = row.element_info
            e.tar_id = lookup(e.tar_id)
            e.uniqueId = lookup(e.uniqueId)
            if (e.parentUniqueId !== undefined) e.parentUniqueId = lookup(e.parentUniqueId)
            verify(e.verify_info)
            const b = e.buff
            if (b) {
                for (const k of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
                    if (b[k] !== undefined) b[k] = lookup(b[k])
                if ([1, 7, 10].includes(e.op) && b.cfg_id !== undefined) b.cfg_id = lookup(b.cfg_id, true)
                if ([1, 7].includes(e.op))
                    b.begin_time = BigInt.asUintN(64, base - BigInt(u64(b.begin_time))).toString()
                for (const entry of b.entrys ?? [])
                    if ([3, 4].includes(entry.key))
                        entry.ui64_dic_values = (entry.ui64_dic_values ?? []).map((x) => lookup(x))
            }
        }
        // AddAttrChangeInfo does not dictionary-compress uuid or values.
        if (row.attr_change) row.attr_change.uuid = u64(row.attr_change.uuid)
        return row
    })
}
export function combatState(state, now) {
    const previous = state.combat
    const readHighWater = (value) => {
        ensure(
            typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= MAX_U64,
            'Invalid combat report time high-water mark',
            ErrorCode.GameConfig,
        )
        return BigInt(value)
    }
    // Older saves kept the accepted clock only inside the disposable combat
    // context. Migrate that known value without inventing a spawn timestamp.
    if (state.combatReportHighWaterMs === undefined && previous?.last_base_time !== undefined) {
        readHighWater(previous.last_base_time)
        state.combatReportHighWaterMs = previous.last_base_time
    }
    const highWater =
        state.combatReportHighWaterMs === undefined ? undefined : readHighWater(state.combatReportHighWaterMs)
    const freshRuntime = !previous || previous.map_id !== state.world.map_id
    const allocateRuntime = () => {
        const floor =
            Number.isSafeInteger(previous?.runtimeEpoch) && previous.runtimeEpoch > 0 ? previous.runtimeEpoch + 1 : 1
        const next = state.nextCombatRuntimeEpoch ?? floor
        ensure(
            Number.isSafeInteger(next) && next >= floor && next <= 0xffffffff,
            'Invalid or exhausted combat runtime epoch',
            ErrorCode.GameConfig,
        )
        state.nextCombatRuntimeEpoch = next + 1
        return next
    }
    if (freshRuntime)
        state.combat = {
            map_id: state.world.map_id,
            runtimeEpoch: allocateRuntime(),
            skills: {},
            bullets: {},
            elements: {},
            entities: {},
            report_count: 0,
        }
    const battle = state.combat
    if (battle.runtimeEpoch === undefined) battle.runtimeEpoch = allocateRuntime()
    ensure(
        Number.isSafeInteger(battle.runtimeEpoch) && battle.runtimeEpoch > 0 && battle.runtimeEpoch <= 0xffffffff,
        'Invalid combat runtime epoch',
        ErrorCode.GameConfig,
    )
    if (state.nextCombatRuntimeEpoch === undefined) state.nextCombatRuntimeEpoch = battle.runtimeEpoch + 1
    ensure(
        Number.isSafeInteger(state.nextCombatRuntimeEpoch) && state.nextCombatRuntimeEpoch > battle.runtimeEpoch,
        'Combat runtime allocator would reuse an epoch',
        ErrorCode.GameConfig,
    )
    if (battle.runtimeActivatedAtMs === undefined) {
        const transition = state.world.scene_transition
        const admitted =
            transition?.to_map_id === state.world.map_id
                ? transition.started_at
                : state.world.client_loaded === true
                  ? state.world.loaded_at
                  : undefined
        // Only a recorded authoritative entry provides a time barrier. First
        // observation itself is not evidence of when the monster was spawned.
        let barrier = Number.isSafeInteger(admitted) && admitted > 0 ? BigInt(admitted) * 1000n : 0n
        // Capture this once at genuine runtime creation. Reading the moving
        // high-water on every first group observation would reject valid
        // same-millisecond reports for other groups in the same runtime.
        if (freshRuntime && highWater !== undefined && highWater >= barrier) barrier = highWater + 1n
        ensure(barrier <= MAX_U64, 'Combat runtime timestamp exhausted', ErrorCode.GameConfig)
        battle.runtimeActivatedAtMs = barrier.toString()
    }
    for (const [id, b] of Object.entries(battle.bullets)) if (now - b.updated_at > 120) delete battle.bullets[id]
    return battle
}
export function boundedSet(map, id, value, limit) {
    if (!Object.hasOwn(map, id) && Object.keys(map).length >= limit) delete map[Object.keys(map)[0]]
    map[id] = value
}
