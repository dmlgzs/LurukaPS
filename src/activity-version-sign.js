import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'

const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const models = new WeakMap()
function model(tables, row) {
    let cache = models.get(tables)
    if (!cache) models.set(tables, (cache = new Map()))
    if (cache.has(row.systemId)) return cache.get(row.systemId)
    ensure(
        tables.find('game_events_day_attendance_group_2d', row.systemId),
        'Version sign display configuration unavailable',
        ErrorCode.ActivityExConfNone,
    )
    const days = tables
        .get('game_events_day_attendance_2d')
        .filter((day) => day.eventId === row.systemId)
        .toSorted((a, b) => a.date - b.date)
    ensure(days.length > 0, 'Version sign rewards unavailable', ErrorCode.ActivityRewardConfNone)
    const ids = new Set()
    const rewards = days.map((day, index) => {
        ensure(
            uint(day.id) && day.id > 0 && !ids.has(day.id) && day.date === index + 1,
            'Invalid version sign reward sequence',
            ErrorCode.GameConfig,
        )
        ids.add(day.id)
        const items = parseRewards(day.reward)
        ensure(
            items.length > 0 &&
                items.every((item) =>
                    [item.itemtype, item.itemid, item.itemnum].every((value) => uint(value) && value > 0),
                ),
            'Invalid version sign reward definition',
            ErrorCode.GameConfig,
        )
        return items
    })
    cache.set(row.systemId, rewards)
    return rewards
}

function ledger(entry, maximum) {
    const data = (entry.versionSign ??= { version: 1, count: 0, time: 0, reward_count: 0, claims: [] })
    ensure(
        data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            data.version === 1 &&
            [data.count, data.time, data.reward_count].every(uint) &&
            data.count <= maximum &&
            data.reward_count <= data.count &&
            (data.count === 0 ? data.time === 0 : data.time > 0) &&
            Array.isArray(data.claims) &&
            data.claims.length <= maximum,
        'Invalid version sign progress',
        ErrorCode.GameConfig,
    )
    let previous = 0
    const keys = new Set()
    for (const claim of data.claims) {
        ensure(
            claim &&
                typeof claim === 'object' &&
                uint(claim.from) &&
                uint(claim.to) &&
                uint(claim.time) &&
                claim.from === previous + 1 &&
                claim.to >= claim.from &&
                claim.to <= data.reward_count &&
                (claim.key === null ||
                    (typeof claim.key === 'string' && /^[a-f0-9]{64}$/.test(claim.key) && !keys.has(claim.key))),
            'Invalid version sign claim receipt',
            ErrorCode.GameConfig,
        )
        previous = claim.to
        if (claim.key !== null) keys.add(claim.key)
    }
    ensure(previous === data.reward_count, 'Version sign rewards have no claim receipt', ErrorCode.GameConfig)
    return data
}

export function versionSignSnapshot(tables, entry, row, now, day) {
    ensure(uint(now) && now > 0 && typeof day === 'function', 'Invalid version sign clock', ErrorCode.GameConfig)
    const rewards = model(tables, row),
        data = ledger(entry, rewards.length)
    // Conservative existing attendance policy: observe one actual active day,
    // not all intervening offline days. Official missed-login/backfill rules
    // are not recovered. Clock rollback never creates another observed day.
    if (data.count < rewards.length && (!data.time || day(now) > day(data.time))) {
        data.count++
        data.time = now
    }
    return { count: data.count, time: data.time, reward_count: data.reward_count }
}

export function claimVersionSign(c, catalog, id) {
    const config = catalog.rows.find((row) => row.id === id)
    ensure(config, 'Unknown version sign activity', ErrorCode.ActivityNotFond)
    ensure(config.type === 4, 'Activity is not a version sign', ErrorCode.ActivityTypeNotEqual)
    const { row, entry } = catalog.require(c.state, c.now, id, [4]),
        rewards = model(c.tables, row)
    versionSignSnapshot(c.tables, entry, row, c.now, (time) => catalog.day(time))
    const data = ledger(entry, rewards.length)
    let key = null
    if (c.requestKey !== null && c.requestKey !== undefined) {
        ensure(
            typeof c.requestKey === 'string' && c.requestKey.length > 0 && c.requestKey.length <= 512,
            'Invalid version sign request identity',
            ErrorCode.GameConfig,
        )
        key = createHash('sha256').update(c.requestKey).digest('hex')
    }
    if ((key && data.claims.some((claim) => claim.key === key)) || data.reward_count === data.count) {
        catalog.notify(c, true)
        return { rewards: [] }
    }
    const from = data.reward_count + 1,
        to = data.count,
        granted = grantRewards(c.tables, c.state, rewards.slice(from - 1, to).flat())
    data.reward_count = to
    data.claims.push({ from, to, time: c.now, key })
    // Publish authoritative stock before the Rewards callback displays it.
    c.pushBefore('CSProtoSyncPlayerData', {
        sbag_infos: c.state.player.sbag_infos,
        attr_infos: c.state.player.attr_infos,
        heros_info: c.state.player.heros_info,
    })
    catalog.notify(c, true)
    const source = rewardSource(c.tables, 'activityVersionSign')
    return { rewards: granted, ...(source === undefined ? {} : { src: source }) }
}
