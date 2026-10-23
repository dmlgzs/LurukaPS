import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const identity = (item) => item.itemtype + ':' + item.itemid
const percent = (fraction) => Number((fraction * 100).toFixed(6)) + '%'
function name(tables, item) {
    const row = tables.find(item.itemtype === 1 ? 'hero' : 'soulessence', item.itemid)
    ensure(row, 'Gacha detail candidate unavailable', ErrorCode.GameConfig)
    return typeof row.name === 'string' && row.name && !/^\d+$/.test(row.name) ? row.name : String(item.itemid)
}

// CardPoolMsg / CardPoolDetail use snake_case fields, not TCP Rewards.
// This describes the configured local draw model, not an unverified official
// consolidated probability. No account, random draw or receipt is touched.
export function gachaPoolDetail(catalog, engine, tables, poolId, defaultImages = {}) {
    ensure(Number.isSafeInteger(poolId) && poolId > 0 && poolId <= 0xffffffff, 'Invalid gacha detail pool')
    ensure(catalog.pools.has(poolId), 'Unknown gacha detail pool')
    const config = catalog.configuration(poolId),
        model = engine.compile(config)
    const candidates = new Map()
    let covered = 0
    for (const rule of model.rules.filter((rule) => rule.isRepeatable || !rule.guaranteeCount)) {
        const mass = rule.probability_mass / model.scale
        covered += rule.probability_mass
        const weights = rule.buckets.reduce((n, bucket) => n + bucket.weight, 0)
        for (const bucket of rule.buckets)
            for (const item of bucket.items) {
                if (!mass) continue
                const key = identity(item),
                    row = candidates.get(key) ?? {
                        item,
                        name: name(tables, item),
                        mass: 0,
                        is_up: false,
                        star: tables.find(item.itemtype === 1 ? 'hero' : 'soulessence', item.itemid).rarity + 1,
                    }
                row.mass += (mass * bucket.weight) / weights / bucket.items.length
                row.is_up ||= bucket.field.startsWith('UP_')
                candidates.set(key, row)
            }
    }
    ensure(covered === model.scale, 'Gacha detail has no complete ordinary distribution', ErrorCode.GameConfig)
    const groups = Object.fromEntries(
        [5, 4, 3].map((star) => {
            const rows = [...candidates.values()].filter((row) => row.star === star)
            return [
                'star' + star,
                {
                    hidden: !rows.length,
                    text: '基础概率 ' + percent(rows.reduce((n, row) => n + row.mass, 0)),
                    objects: rows.map((row) => ({ name: row.name, is_up: row.is_up })),
                },
            ]
        }),
    )
    const configuredImages = engine.policy.detail_images ?? {}
    ensure(
        configuredImages &&
            typeof configuredImages === 'object' &&
            !Array.isArray(configuredImages) &&
            defaultImages &&
            typeof defaultImages === 'object' &&
            !Array.isArray(defaultImages),
        'Invalid gacha detail image map',
        ErrorCode.GameConfig,
    )
    const images = { ...defaultImages, ...configuredImages }
    const up = [...candidates.values()].filter((row) => row.is_up && row.star >= 4)
    for (const row of up)
        if (images[identity(row.item)] !== undefined) {
            ensure(
                typeof images[identity(row.item)] === 'string' && /^https?:\/\//i.test(images[identity(row.item)]),
                'Invalid gacha detail image URL',
                ErrorCode.GameConfig,
            )
        }
    const upGroups = Object.fromEntries(
        [5, 4].map((star) => {
            const all = [...candidates.values()].filter((row) => row.star === star)
            const rows = all.filter((row) => row.is_up)
            const total = all.reduce((n, row) => n + row.mass, 0)
            return [
                'star' + star,
                {
                    ratio: percent(total ? rows.reduce((n, row) => n + row.mass, 0) / total : 0),
                    objects: rows.map((row) => ({ name: row.name, cdnImage: images[identity(row.item)] ?? '' })),
                },
            ]
        }),
    )
    const ticketId = catalog.types.get(config.gachaType)?.costItem
    const ticket = tables.find('common_item', ticketId)
    ensure(ticket, 'Gacha detail ticket unavailable', ErrorCode.GameConfig)
    const fee = engine.fee(config, { pool_draw_count: 1 }, 10)
    const costs = [`每次观测消耗${ticket.name}，十连消耗${fee}枚。`]
    if (config.onlyTenPull) costs.push('仅支持十连观测。')
    if (config.gachaLimit) costs.push(`本池最多观测${config.gachaLimit}次。`)
    if (String(config.specialRule).split('|').includes('FIRST_FREE')) costs.push('首次单次观测免费。')
    if (config.selfChoose) costs.push(`累计${config.selfChoose}次观测后可领取一次新手自选角色。`)
    const guarantees = model.rules
        .filter((rule) => rule.guaranteeCount > 0)
        .map((rule) => {
            const scope =
                rule.members.size === 1
                    ? name(tables, rule.buckets[0].items[0])
                    : `${rule.minimum + 1}星${rule.guaranteeType === 3 ? '及以上' : ''}`
            return `${rule.isRepeatable ? '最多' : '首次最多'}${rule.guaranteeCount}次观测保证获得${scope}。`
        })
    if (model.probabilityModel) {
        const rule = model.probabilityModel
        const increase = percent(rule.increment_mass / model.scale).replace('%', '')
        guarantees.push(
            `连续${rule.soft_start_after}次未获得五星后，第${rule.soft_start_after + 1}次起每次增加${increase}个百分点，第${rule.hard_pity}次必得五星；获得五星后重新计数。`,
        )
        guarantees.push('本观测类别的卡池继承保底计数，其他观测类别独立计数。')
    }
    if (config.selfChooseuplist)
        guarantees.push(
            engine.policy.aimed_ssr_policy === 'selected'
                ? '五星灵子命中时使用当前选定的定轨目标。'
                : '五星灵子按本池候选随机获得。',
        )
    return {
        // The renderer downloads these images through CDNManager.DownloadToTex.
        // HTTP supplies real local client portraits; explicit deployment URLs
        // override individual images without changing the draw model or state.
        probability_up_target: { hidden: !up.length || up.some((row) => !images[identity(row.item)]), ...upGroups },
        detail_description: {
            hidden: false,
            paragraphs: [
                { title: '离线卡池规则', content: ['以下为本地服务端当前规则，基础概率不含保底与一次性保证。'] },
                { title: '观测消耗', content: costs },
                { title: '保证与定轨', content: guarantees },
            ],
        },
        probability_detail: { hidden: false, ...groups },
    }
}
