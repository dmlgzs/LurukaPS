import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import policy from '../configs/pami-mail-policy.json' with { type: 'json' }
const catalogs = new WeakMap()
const warned = new Set()
function warnRejected(row, reasons) {
    const key = JSON.stringify([row.id, reasons])
    if (warned.has(key)) return
    warned.add(key)
    while (warned.size > 256) warned.delete(warned.values().next().value)
    console.warn('[pami-mail] ' + JSON.stringify({ event: 'invalid-letter-config', letter_id: row.id, reasons }))
}

const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const terms = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map((s) => s.split('#').map(Number))
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const groups = new Map(tables.get('pami_letter_group').map((r) => [r.id, r]))
    const categories = new Map(tables.get('pami_letter_category').map((r) => [r.id, r]))
    const texts = new Map(tables.get('pami_letter_text').map((r) => [r.id, r]))
    const replies = new Map(tables.get('pami_letter_reply').map((r) => [r.id, r]))
    const systems = new Map(tables.get('system_unlock').map((r) => [r.id, r]))
    const letters = new Map(),
        rejected = [],
        events = []
    for (const row of tables.get('pami_letter_list')) {
        const group = groups.get(row.groupId),
            category = group && categories.get(group.categoryId),
            first = texts.get(row.firstId)
        const reasons = []
        if (!group || !category) reasons.push('missing group/category')
        if (!first || first.letterId !== row.id) reasons.push('missing/mismatched first text')
        for (const text of texts.values()) {
            if (text.letterId !== row.id || !text.reward) continue
            try {
                for (const reward of parseRewards(text.reward)) {
                    if (reward.itemtype !== 3)
                        reasons.push('text ' + text.id + ': unvalidated attachment type ' + reward.itemtype)
                    else if (!tables.find('common_item', reward.itemid))
                        reasons.push('text ' + text.id + ': missing attachment common_item ' + reward.itemid)
                }
            } catch {
                reasons.push('text ' + text.id + ': malformed attachment reward')
            }
        }
        const rules = terms(row.condition)
        if (rules.some((t) => ![13000, 12082, 2007].includes(t[0]) || t.some((v) => !Number.isSafeInteger(v))))
            reasons.push('unsupported condition')
        if (reasons.length) {
            rejected.push({ id: row.id, reasons })
            warnRejected(row, reasons)
            continue
        }
        if (row.type === 4) {
            events.push(row.id)
            continue
        }
        ensure(
            [2, 3].includes(row.type) && uint(row.time) && uint(row.disappear),
            'Invalid Pami letter schedule',
            ErrorCode.PamiLetterTextConfFail,
        )
        ensure(systems.has(category.systemId), 'Pami category unlock configuration missing', ErrorCode.GameConfig)
        letters.set(row.id, { ...row, group, category, first, rules })
    }
    const result = { letters, groups, categories, texts, replies, systems, rejected, events }
    catalogs.set(tables, result)
    return result
}
export function pamiCoverage(tables) {
    const d = catalog(tables)
    return {
        configured: tables.get('pami_letter_list').length,
        ordinary: d.letters.size,
        rejected: d.rejected,
        eventLetters: d.events,
    }
}
function stateData(state) {
    const data = (state.pamiMail ??= { version: 1, letters: {}, revision: 0 })
    ensure(
        data.version === 1 && data.letters && typeof data.letters === 'object' && !Array.isArray(data.letters),
        'Invalid Pami mailbox state',
        ErrorCode.GameConfig,
    )
    return data
}
function permanentHero(state, id) {
    return state.player.heros_info.heros.find((h) => h.conf_id === id && !h.trail)
}
function unlocked(data, state, row) {
    const system = data.systems.get(row.category.systemId)
    ensure(system, 'Pami category system configuration missing', ErrorCode.GameConfig)
    return homeCondition(system.unlockCondi, state)
}
function eligible(data, state, row, now, completionPolicy) {
    if (!unlocked(data, state, row)) return false
    return row.rules.every(([kind, ...p]) => {
        if (kind === 13000) {
            ensure(
                p.length === 2 && p.every((v) => v > 0),
                'Invalid Pami favorability condition',
                ErrorCode.PamiLetterTextConfFail,
            )
            const h = permanentHero(state, p[0])
            return !!h && h.favorability_lv >= p[1]
        }
        if (kind === 2007) {
            ensure(p.length === 1 && p[0] > 0, 'Invalid Pami task condition', ErrorCode.PamiLetterTextConfFail)
            return (state.taskRecords ?? []).some((r) => r.task_id === p[0] && r.count > 0)
        }
        ensure(p.length === 1 && p[0] > 0, 'Invalid Pami predecessor condition', ErrorCode.PamiLetterTextConfFail)
        if (completionPolicy === 'closed') return false
        const previous = stateData(state).letters[p[0]]
        return previous?.completed_at !== undefined && previous.completed_at <= now
    })
}
function signature(data, state) {
    const heroes = new Map(state.player.heros_info.heros.filter((h) => !h.trail).map((h) => [h.conf_id, h]))
    const gates = [...data.categories.values()].map((c) =>
        homeCondition(data.systems.get(c.systemId)?.unlockCondi, state) ? 1 : 0,
    )
    const favor = [...data.groups.values()]
        .filter((g) => g.heroId > 0)
        .map((g) => heroes.get(g.heroId)?.favorability_lv ?? 0)
    const taskIds = [
        ...new Set([...data.letters.values()].flatMap((r) => r.rules.filter((t) => t[0] === 2007).map((t) => t[1]))),
    ]
    return (
        gates.join(',') +
        '/' +
        favor.join(',') +
        '/' +
        taskIds.map((id) => ((state.taskRecords ?? []).some((r) => r.task_id === id && r.count > 0) ? 1 : 0)).join(',')
    )
}
// TODO(pami-12082-official-completion): conservative local compatibility policy.
// The local condition evaluator was not recovered. Reading alone never finishes
// a letter: the displayed dialogue must end and every reachable gift must be claimed.
function completionMode(options = {}) {
    const mode = options.completionPolicy ?? policy.completionPolicy
    ensure(
        ['closed', 'conversation-and-rewards'].includes(mode),
        'Invalid Pami completion policy',
        ErrorCode.GameConfig,
    )
    return mode
}
function finishInfo(data, entry, now) {
    if (!entry.latest_read || !visible(data, entry, now)) return undefined
    const row = data.letters.get(entry.mail_id),
        text = data.texts.get(row.firstId)
    const record = entry.reply.find((r) => r.text_id === text.id)
    if (!record) return undefined
    if (text.reward && !entry.reward.includes(text.id)) return undefined
    let terminal = false
    if (record.record) {
        const choice = data.replies.get(record.record)
        ensure(choice?.teamId === text.teamId, 'Invalid saved Pami selected reply', ErrorCode.GameConfig)
        terminal = choice.textId === 0
    } else terminal = !text.teamId && text.isEnd === 1
    if (!terminal) return undefined
    return Math.max(entry.timestamp + row.time, record.timestamp, entry.read_at ?? now, entry.reward_at ?? 0)
}
export function preparePamiMail(tables, state, now, options = {}) {
    ensure(uint(now), 'Invalid Pami server time', ErrorCode.GameConfig)
    const data = catalog(tables),
        ledger = stateData(state),
        mode = completionMode(options),
        sig = signature(data, state) + '/' + ledger.revision + '/' + mode
    if (ledger.observed === sig) return false
    let changed = false
    if (mode !== 'closed')
        for (const entry of Object.values(ledger.letters)) {
            if (!data.letters.has(entry.mail_id)) continue
            const completeAt = finishInfo(data, entry, now)
            if (completeAt !== undefined && entry.completed_at === undefined) {
                entry.completed_at = completeAt
                changed = true
            }
        }
    for (const row of data.letters.values()) {
        if (ledger.letters[row.id] || !eligible(data, state, row, now, mode)) continue
        ensure(now + row.time <= 0xffffffff, 'Pami delivery time exhausted', ErrorCode.GameConfig)
        const hero = permanentHero(state, row.group.heroId)
        ledger.letters[row.id] = {
            mail_id: row.id,
            hero_id: hero?.guid ?? '0',
            timestamp: now,
            latest_read: false,
            reply: [{ text_id: row.firstId, record: 0, timestamp: now }],
            reward: [],
            args: [],
        }
        changed = true
    }
    if (changed) ledger.revision++
    ledger.observed = signature(data, state) + '/' + ledger.revision + '/' + mode
    return changed
}
function visible(data, entry, now) {
    const row = data.letters.get(entry.mail_id)
    ensure(row, 'Saved Pami letter configuration unavailable', ErrorCode.PamiLetterTextConfFail)
    ensure(
        uint(entry.timestamp) &&
            typeof entry.latest_read === 'boolean' &&
            Array.isArray(entry.reply) &&
            Array.isArray(entry.reward),
        'Invalid saved Pami letter',
        ErrorCode.GameConfig,
    )
    ensure(
        entry.reply.length > 0 &&
            entry.reply.every((r) => {
                const text = data.texts.get(r.text_id),
                    choice = r.record ? data.replies.get(r.record) : undefined
                return (
                    text?.letterId === entry.mail_id &&
                    uint(r.timestamp) &&
                    uint(r.record) &&
                    (!r.record || choice?.teamId === text.teamId)
                )
            }) &&
            new Set(entry.reply.map((r) => r.text_id)).size === entry.reply.length &&
            entry.reward.every((id) => data.texts.get(id)?.letterId === entry.mail_id && data.texts.get(id).reward) &&
            new Set(entry.reward).size === entry.reward.length,
        'Invalid saved Pami text, choice or attachment record',
        ErrorCode.GameConfig,
    )
    return now >= entry.timestamp + row.time && (!row.disappear || now < entry.timestamp + row.disappear)
}
export function pamiMailSnapshot(tables, state, now) {
    const data = catalog(tables),
        ledger = stateData(state)
    return {
        mail_tab: [...data.categories.keys()]
            .sort((a, b) => a - b)
            .map((mail_type) => ({
                mail_type,
                contents: Object.values(ledger.letters)
                    .filter(
                        (e) =>
                            data.letters.has(e.mail_id) &&
                            (visible(data, e, now) || now < e.timestamp + data.letters.get(e.mail_id).time) &&
                            data.letters.get(e.mail_id).category.id === mail_type,
                    )
                    .sort((a, b) => a.mail_id - b.mail_id)
                    .map((e) => ({
                        mail_id: e.mail_id,
                        hero_id: e.hero_id,
                        reply: e.reply.map((r) => ({ ...r })),
                        latest_read: e.latest_read,
                        timestamp: e.timestamp,
                        reward: [...e.reward],
                        args: e.args ?? [],
                    })),
            })),
    }
}
export function pamiLetter(tables, state, id, now) {
    const data = catalog(tables),
        row = data.letters.get(id),
        entry = stateData(state).letters[id]
    ensure(
        row && entry && unlocked(data, state, row) && visible(data, entry, now),
        'Pami letter is not delivered or available',
        ErrorCode.PamiLetterNotFound,
    )
    return { row, entry, data }
}
export function notifyPamiMail(c, name) {
    if (!/(?:Task|Hero|PamiMail|GMCommand)/.test(name)) return
    if (preparePamiMail(c.tables, c.state, c.now))
        c.pushBefore('CSProtoPamiMailSync', pamiMailSnapshot(c.tables, c.state, c.now))
}
export function registerPamiMail(on) {
    on('PamiMailRead', (c, r) => {
        preparePamiMail(c.tables, c.state, c.now)
        const { entry } = pamiLetter(c.tables, c.state, r.u32, c.now)
        if (!entry.latest_read) {
            entry.latest_read = true
            entry.read_at = c.now
            stateData(c.state).revision++
        }
        preparePamiMail(c.tables, c.state, c.now)
        c.pushBefore('CSProtoPamiMailSync', pamiMailSnapshot(c.tables, c.state, c.now))
        return {}
    })
    on('PamiMailChoose', (c, r) => {
        preparePamiMail(c.tables, c.state, c.now)
        const data = catalog(c.tables),
            text = data.texts.get(r.text_id),
            choice = data.replies.get(r.reply_id)
        ensure(text, 'Pami source text configuration not found', ErrorCode.PamiLetterTextConfFail)
        const { row, entry } = pamiLetter(c.tables, c.state, text.letterId, c.now)
        ensure(text.id === row.firstId, 'Pami source text is not reached', ErrorCode.PamiLetterNotFound)
        ensure(
            choice && choice.teamId === text.teamId && text.teamId > 0,
            'Pami reply does not belong to this text',
            ErrorCode.PamiLetterReplyConfFail,
        )
        ensure(choice.textId === 0, 'Pami continuation text requires support', ErrorCode.FunctionClosed)
        const record = entry.reply.find((t) => t.text_id === text.id)
        ensure(record, 'Pami text is not delivered', ErrorCode.PamiLetterNotFound)
        ensure(
            !record.record || record.record === choice.id,
            'Pami reply choice is already committed',
            ErrorCode.InvalidArgument,
        )
        if (!record.record) {
            record.record = choice.id
            record.timestamp = c.now
            stateData(c.state).revision++
        }
        preparePamiMail(c.tables, c.state, c.now)
        // The old Lua success callback appends locally; publish authority after
        // ACK so that append is replaced, rather than duplicating its record.
        c.push('CSProtoPamiMailSync', pamiMailSnapshot(c.tables, c.state, c.now))
        return {}
    })
    on('PamiMailReward', (c, r) => {
        preparePamiMail(c.tables, c.state, c.now)
        const data = catalog(c.tables),
            text = data.texts.get(r.u32)
        ensure(text, 'Pami reward text configuration not found', ErrorCode.PamiLetterTextConfFail)
        const { row, entry } = pamiLetter(c.tables, c.state, text.letterId, c.now)
        ensure(
            text.id === row.firstId && entry.reply.some((t) => t.text_id === text.id),
            'Pami reward text is not reached',
            ErrorCode.PamiLetterNotFound,
        )
        ensure(text.reward, 'Pami text has no attachment', ErrorCode.InvalidArgument)
        if (entry.reward.includes(text.id)) {
            c.push('CSProtoPamiMailSync', pamiMailSnapshot(c.tables, c.state, c.now))
            return { rewards: [] }
        }
        const rewards = grantRewards(c.tables, c.state, parseRewards(text.reward))
        entry.reward.push(text.id)
        entry.reward_at = c.now
        stateData(c.state).revision++
        preparePamiMail(c.tables, c.state, c.now)
        const source = rewardSource(c.tables, 'pamiMailReward')
        c.push('CSProtoPamiMailSync', pamiMailSnapshot(c.tables, c.state, c.now))
        return { ...(source === undefined ? {} : { src: source }), rewards }
    })
}
