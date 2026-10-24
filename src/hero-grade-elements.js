import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { heroGradeEffects, heroGradeElementIds } from './hero-grade.js'
import { temporaryHeroes } from './trial-actors.js'
import { arenaElementMetadata } from './npc-kibo-elements.js'
import { arenaElementPacket as battleElementPacket } from './npc-kibo-controls.js'
import policy from '../configs/hero-grade-element-policy.json' with { type: 'json' }

ensure(
    policy.version === 1 &&
        policy.transport === '10706-op10' &&
        policy.refresh === 'replace-selected-roots-on-initialize-request' &&
        policy.uidPrefix === 62 &&
        policy.sequenceBits === 25 &&
        policy.officially_verified === false,
    'Hero grade element policy unavailable',
    ErrorCode.GameConfig,
)
const maximum = 0x1ffffff,
    prefix = 0x3en << 57n,
    object = (value) => value && typeof value === 'object' && !Array.isArray(value),
    positiveUid = (value) =>
        typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn

function sequence(state) {
    const value = state.heroGradeElementSequence ?? 0
    ensure(
        Number.isSafeInteger(value) && value >= 0 && value <= maximum,
        'Invalid hero grade element sequence',
        ErrorCode.GameConfig,
    )
    return value
}
function owner(c) {
    ensure(
        Number.isSafeInteger(c.id) && c.id > 0 && c.id <= 0xffffffff,
        'Invalid grade element owner',
        ErrorCode.GameConfig,
    )
    return BigInt(c.id)
}
function allocate(c) {
    const value = sequence(c.state)
    ensure(value < maximum, 'Hero grade element identity capacity exceeded', ErrorCode.GameConfig)
    const uid = (prefix | (BigInt(value + 1) << 32n) | owner(c)).toString()
    c.state.heroGradeElementSequence = value + 1
    return uid
}
function oldRows(c, bindings, id) {
    const rows = bindings.heroes[id] ?? []
    ensure(
        Array.isArray(rows) &&
            rows.length <= 64 &&
            rows.every(
                (row) =>
                    object(row) && Number.isSafeInteger(row.config_id) && row.config_id > 0 && positiveUid(row.uid),
            ) &&
            new Set(rows.map((row) => row.config_id)).size === rows.length &&
            new Set(rows.map((row) => row.uid)).size === rows.length,
        'Saved hero grade element binding is malformed',
        ErrorCode.GameConfig,
    )
    for (const row of rows) {
        const uid = BigInt(row.uid),
            index = (uid >> 32n) & BigInt(maximum)
        ensure(
            uid >> 57n === 0x3en &&
                (uid & 0xffffffffn) === owner(c) &&
                index > 0n &&
                index <= BigInt(sequence(c.state)),
            'Saved hero grade element allocation is inconsistent',
            ErrorCode.GameConfig,
        )
    }
    return rows
}
function deleteRow(actor, uid) {
    return { op: 2, tar_id: actor, uniqueId: uid, buff: { executor_id: actor, attacker_id: actor } }
}

// The current caller is HeroEntity.Initialize, not a per-frame effect tick.
// A refresh replaces only this selected actor's authored grade roots. Native
// root cleanup owns its configured children; unrelated actors are untouched.
export function refreshHeroGradeElements(c, selected, battle) {
    const knownHeroes = new Map(
            [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].map((hero) => [hero.guid, hero]),
        ),
        saved = battle.hero_grade_elements ?? { version: 1, heroes: {} }
    ensure(
        object(saved) && saved.version === 1 && object(saved.heroes) && Object.keys(saved.heroes).length <= 256,
        'Saved hero grade element state is malformed',
        ErrorCode.GameConfig,
    )
    const allocated = new Map()
    for (const id of Object.keys(saved.heroes))
        for (const row of oldRows(c, saved, id)) {
            ensure(!allocated.has(row.uid), 'Duplicate saved hero grade element identity', ErrorCode.GameConfig)
            allocated.set(row.uid, id)
        }
    const next = Object.fromEntries(Object.entries(saved.heroes).filter(([id]) => knownHeroes.has(id))),
        removals = [],
        additions = [],
        removeRoots = new Set(),
        seenDeletes = new Set(),
        millis = Math.round(c.now * 1000)
    ensure(Number.isSafeInteger(millis) && millis >= 0, 'Invalid hero grade element time', ErrorCode.InvalidTime)
    let changed = Object.keys(next).length !== Object.keys(saved.heroes).length
    for (const id of selected) {
        const hero = knownHeroes.get(id)
        if (!hero) continue // Preserve existing11904 generic replay for nonhero actors.
        const configs = heroGradeEffects(hero).elements,
            possible = heroGradeElementIds(hero.conf_id),
            previous = oldRows(c, saved, id),
            roots = new Set(previous.map((row) => row.uid))
        ensure(configs.length <= 64, 'Hero grade element binding capacity exceeded', ErrorCode.FunctionClosed)
        for (const config of configs)
            ensure(
                arenaElementMetadata(config).status === 'resolved',
                'Hero grade element resource metadata unavailable',
                ErrorCode.FunctionClosed,
            )
        // Recognize only an observed native grade source with a matching
        // authored root, not an arbitrary same-config skill/weapon effect.
        for (const [uid, row] of Object.entries(battle.elements))
            if (
                row.tar_id === id &&
                String(row.buff?.executor_id ?? row.tar_id) === id &&
                String(row.buff?.attacker_id ?? '0') === id &&
                String(row.buff?.creator_id ?? '0') === id &&
                row.verify_info?.source_type === 6 &&
                String(row.verify_info.source_id ?? '0') === '6' &&
                possible.has(row.buff?.cfg_id)
            ) {
                const actual = row.uniqueId ?? uid
                ensure(positiveUid(actual), 'Invalid observed hero grade root identity', ErrorCode.GameConfig)
                roots.add(actual)
            }
        if (!configs.length && !roots.size) continue
        for (const uid of roots) {
            removeRoots.add(uid)
            if (!seenDeletes.has(uid)) {
                removals.push(deleteRow(id, uid))
                seenDeletes.add(uid)
            }
        }
        const rows = configs.map((config) => ({
            config_id: config,
            uid: previous.find((row) => row.config_id === config)?.uid ?? allocate(c),
        }))
        next[id] = rows
        changed = true
        for (const row of rows)
            additions.push({
                op: 10,
                tar_id: id,
                uniqueId: row.uid,
                buff: {
                    cfg_id: row.config_id,
                    layer: 1,
                    begin_time: String(millis),
                    attacker_id: id,
                    executor_id: id,
                    source_id: id,
                    creator_id: id,
                },
                verify_info: {
                    battle_index: '0',
                    related_index: '0',
                    source_type: 6,
                    source_id: '6',
                    op_time: String(millis),
                },
            })
    }
    // End observed old self-target descendants too: an authored root can have
    // already finished while its child persists. Do not clear other actors or
    // invent unreported parent relationships.
    const children = new Map()
    for (const [uid, row] of Object.entries(battle.elements)) {
        if (!selected.has(row.tar_id) || !row.parentUniqueId || row.parentUniqueId === '0') continue
        if (!children.has(row.parentUniqueId)) children.set(row.parentUniqueId, [])
        children.get(row.parentUniqueId).push({ uid: row.uniqueId ?? uid, actor: row.tar_id })
    }
    const removed = new Set(removeRoots),
        queue = [...removed]
    for (let index = 0; index < queue.length; index++)
        for (const child of children.get(queue[index]) ?? [])
            if (!removed.has(child.uid)) {
                ensure(positiveUid(child.uid), 'Invalid observed hero grade descendant identity', ErrorCode.GameConfig)
                removed.add(child.uid)
                queue.push(child.uid)
                if (!seenDeletes.has(child.uid)) {
                    removals.push(deleteRow(child.actor, child.uid))
                    seenDeletes.add(child.uid)
                }
            }
    if (removed.size)
        battle.elements = Object.fromEntries(
            Object.entries(battle.elements).filter(
                ([uid, row]) => !selected.has(row.tar_id) || !removed.has(row.uniqueId ?? uid),
            ),
        )
    if (changed) battle.hero_grade_elements = { version: 1, heroes: next }
    if (removals.length || additions.length)
        c.push('SCProtoBattleInfoReduceNtf', battleElementPacket([...removals, ...additions]))
}
