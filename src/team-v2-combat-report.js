import { createHash } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { combatState, expandBattleReport, u64 } from './combat-state.js'
import { damageReceipt } from './combat-hurt-receipts.js'

// Current OnExecuteDamageElement sends op10 when its target is remote,then
// returns without numerical HP. Only the target controller executes that
// command through OnSCProtoBattleInfoReduceNtf -> OnAddBuffInfoSync.
export function reduceSharedCombatReport(c, request, { run, blueprint, actors, reduce }) {
    const encounter = structuredClone(run.encounter),
        rows = expandBattleReport(request),
        normal = [],
        relays = [],
        frames = [],
        dead = new Set(),
        duplicateRows = new Set(),
        hurtSnapshots = new Map()
    encounter.elements ??= {}
    encounter.hurt_receipts ??= {}
    encounter.remote_relays ??= {}
    encounter.damage_by_player ??= {}
    const isEnemy = (id) => Object.hasOwn(blueprint.entities, id),
        group = (id) => blueprint.groups[blueprint.entities[id]?.object_id],
        active = (id, allowDead = false) =>
            !isEnemy(id) ||
            group(id).stage_index === encounter.stage_index ||
            (allowDead && encounter.entities[id].hp === 0 && group(id).stage_index < encounter.stage_index),
        actor = (value) => {
            const id = u64(value)
            ensure(id !== '0' && (actors.has(id) || isEnemy(id)), 'Actor is not in the current shared encounter')
            return id
        },
        owner = (id) =>
            actors.get(id)?.id ??
            (isEnemy(id)
                ? group(id).object_id === encounter.control?.object_id
                    ? encounter.control.player_id
                    : encounter.entities[id].hp === 0 && group(id).stage_index < encounter.stage_index
                      ? run.captain
                      : null
                : null),
        clockIsCurrent = (event) => {
            const time = BigInt(event.verify_info?.op_time ?? request.base_time ?? '0')
            return time >= BigInt(encounter.battle_start_time ?? encounter.created_at) * 1000n
        }
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index],
            event = row.hurt_info ?? row.element_info ?? row.attr_change,
            target = row.hurt_info?.tar_id ?? row.element_info?.tar_id ?? row.attr_change?.uuid
        if (target !== '0') actor(target)
        if (!clockIsCurrent(event)) continue
        if (row.hurt_info) {
            const h = row.hurt_info
            if (h.from_id !== '0') actor(h.from_id)
            if (!active(h.tar_id, true) || !active(h.from_id)) continue
            ensure(
                target === '0' ? h.hp_change === undefined && owner(h.from_id) === c.id : owner(target) === c.id,
                'Shared HP reporter does not control its target',
            )
        } else if (row.element_info) {
            const e = row.element_info
            ensure(Number.isInteger(e.op) && e.op >= 1 && e.op <= 12, 'Unknown element operation')
            ensure(e.op <= 10, 'Current shared element operation has no execution path', ErrorCode.FunctionClosed)
            ensure(e.buff, 'Shared element notification is missing its current client payload')
            for (const key of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
                if (e.buff[key] && e.buff[key] !== '0') actor(e.buff[key])
            ensure(
                !e.buff.executor_id || e.buff.executor_id === target,
                'Shared element executor does not match its target',
            )
            if (!active(target) || !active(e.buff.attacker_id)) continue
            if (e.op === 10) {
                ensure(
                    owner(e.buff.attacker_id) === c.id && owner(target) && owner(target) !== c.id,
                    'Remote damage effect is not from the controlled attacker to a remote target',
                )
                ensure(e.uniqueId !== '0', 'Remote damage effect has no instance identity')
                const key = `${c.id}:${e.buff.attacker_id}:${target}:${e.uniqueId}:${e.verify_info?.battle_index ?? '0'}:${e.verify_info?.op_time ?? request.base_time ?? '0'}`,
                    fingerprint = createHash('sha256').update(JSON.stringify(e)).digest('hex'),
                    prior = encounter.remote_relays[key]
                ensure(!prior || prior.fingerprint === fingerprint, 'Conflicting remote damage effect replay')
                if (!prior) {
                    encounter.remote_relays[key] = {
                        fingerprint,
                        player_id: c.id,
                        attacker: e.buff.attacker_id,
                        target,
                        controller: owner(target),
                    }
                    relays.push({ recipient: owner(target), row: structuredClone(request.battle_info[index]), index })
                }
                continue
            }
            ensure(owner(target) === c.id, 'Shared element reporter does not control its target')
        } else {
            if (!active(target)) continue
            ensure(owner(target) === c.id, 'Shared attribute reporter does not control its target')
        }
        normal.push({ row, raw: request.battle_info[index], index })
    }
    const battle = combatState(c.state, c.now),
        personalElements = Object.fromEntries(
            Object.entries(battle.elements).filter(([, value]) => !isEnemy(value.tar_id)),
        )
    battle.elements = { ...personalElements, ...encounter.elements }
    const shared = {
        actor,
        definition: (id) => blueprint.entities[id] ?? null,
        enemy: (id) => encounter.entities[id],
        isCurrent: () => true, // Rows already passed current run/target/clock admission.
        duplicate(hurt, localIndex) {
            const result = damageReceipt(encounter.hurt_receipts[c.id], hurt)
            if (result.receipt) encounter.hurt_receipts[c.id] = result.receipt
            if (result.duplicate) duplicateRows.add(normal[localIndex].index)
            return result.duplicate
        },
        noteHurt(localIndex, hurt) {
            hurtSnapshots.set(
                normal[localIndex].index,
                encounter.entities[hurt.tar_id]?.hp ??
                    c.state.player.heros_info.battle_infos.find((value) => value.hero_id === hurt.tar_id)?.hp,
            )
        },
        attributes(value) {
            encounter.entities[value.uuid] = {
                ...encounter.entities[value.uuid],
                reported_attributes: structuredClone(value.attrButeInfos ?? []),
            }
        },
        updateEnemy(id, values, source) {
            if (values.delta === undefined) return null
            const previous = encounter.entities[id],
                hp = previous.hp === 0 ? 0 : Math.max(0, Math.min(previous.max_hp, previous.hp + values.delta)),
                died = previous.hp > 0 && hp === 0,
                lost = Math.max(0, previous.hp - hp)
            const value = {
                ...previous,
                hp,
                alive_state: hp > 0 ? 0 : 1,
                updated_at: c.now,
                ...(died && source !== '0' ? { final_blow_guid: source } : {}),
            }
            encounter.entities[id] = value
            if (died) dead.add(id)
            const sourceOwner = actors.get(source)?.id
            if (lost && sourceOwner)
                encounter.damage_by_player[sourceOwner] = String(
                    BigInt(encounter.damage_by_player[sourceOwner] ?? '0') + BigInt(lost),
                )
            return {
                uuid: id,
                hp,
                sp: value.sp,
                alive_state: value.alive_state,
                reason: 0,
                ...(value.final_blow_guid ? { final_blow_guid: value.final_blow_guid } : {}),
            }
        },
    }
    reduce(
        {
            ...c,
            sharedBattle: shared,
            push(name, value) {
                if (name === 'CSProtoObjBattleInfoSync') frames.push({ name, value: structuredClone(value) })
                else if (name !== 'SCProtoBattleInfoReduceNtf') c.push(name, value)
            },
        },
        { ...request, battle_info: normal.map((value) => value.raw) },
    )
    encounter.elements = Object.fromEntries(
        Object.entries(battle.elements).filter(
            ([, value]) => isEnemy(value.tar_id) && encounter.entities[value.tar_id].hp > 0,
        ),
    )
    battle.elements = Object.fromEntries(Object.entries(battle.elements).filter(([, value]) => !isEnemy(value.tar_id)))
    return {
        encounter,
        dead,
        frames,
        relays,
        report(recipient) {
            return {
                uint64_dic: request.uint64_dic ?? [],
                base_time: request.base_time ?? '0',
                battle_info: [
                    ...normal.flatMap(({ row, raw, index }) => {
                        if (!row.hurt_info) return recipient === c.id ? [] : [{ index, row: structuredClone(raw) }]
                        if (recipient !== c.id && duplicateRows.has(index)) return []
                        const hurt = { ...raw.hurt_info },
                            hp = hurtSnapshots.get(index)
                        if (hp === undefined) delete hurt.cur_hp
                        else hurt.cur_hp = hp
                        return [{ index, row: { hurt_info: hurt } }]
                    }),
                    ...relays.filter((value) => value.recipient === recipient),
                ]
                    .sort((a, b) => a.index - b.index)
                    .map((value) => value.row),
            }
        },
    }
}
