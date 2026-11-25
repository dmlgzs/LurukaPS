import policy from '../configs/mall-schedule-policy.json' with { type: 'json' }
import { tableExportManifest } from './table-source.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const sources = ['mall_shop', 'mall_goods', 'mall_pay_goods', 'mall_shop_recommend']
const packages = ['raw_base_package', 'raw_nostreaming_package', 'raw_streaming_package']

export function mallLocalTimeIds(tables, configured = policy) {
    ensure(
        configured?.version === 2 && typeof configured.enabled === 'boolean',
        'Invalid local mall time policy',
        ErrorCode.GameConfig,
    )
    if (!configured.enabled) return undefined
    ensure(
        configured.localStrategy === 'known-current-mall-no-expiry' &&
            configured.userApproved === true &&
            configured.notOfficial === true &&
            typeof configured.resourceVersion === 'string' &&
            /^\d+$/.test(configured.resourceVersion),
        'Unapproved local mall time policy',
        ErrorCode.GameConfig,
    )
    const manifest = tableExportManifest(tables)
    if (
        !manifest ||
        !packages.every((name) => manifest.packageVersions?.[name] === configured.resourceVersion) ||
        !Object.values(manifest.packageVersions).every((version) => version === configured.resourceVersion)
    )
        return undefined
    const ids = new Set()
    for (const name of sources) {
        ensure(manifest.names.has(name), 'Missing current mall policy source', ErrorCode.GameConfig)
        const rows = tables.get(name)
        ensure(Array.isArray(rows), 'Invalid current mall policy source', ErrorCode.GameConfig)
        for (const row of rows) {
            ensure(
                row && Number.isInteger(row.timelimit) && row.timelimit >= 0 && row.timelimit <= 0xffffffff,
                'Invalid mall time reference',
                ErrorCode.GameConfig,
            )
            if (row.timelimit) ids.add(row.timelimit)
        }
    }
    return ids
}

export function mallLocalSchedule(tables, id, configured = policy) {
    return mallLocalTimeIds(tables, configured)?.has(id) ? { start: 0, end: 0 } : undefined
}

export function mallBeginTimeRefreshWindow(tables, row, configured = policy) {
    ensure(
        row.refreshType === 6 &&
            typeof row.refreshTypeParam === 'string' &&
            /^[1-9]\d*$/.test(row.refreshTypeParam) &&
            Number.isSafeInteger(Number(row.refreshTypeParam)),
        'Invalid BeginTime mall refresh parameter',
        ErrorCode.GameConfig,
    )
    const ids = mallLocalTimeIds(tables, configured)
    ensure(
        ids?.has(row.timelimit) &&
            configured.beginTimeRefresh?.enabled === true &&
            configured.beginTimeRefresh.localStrategy === 'hold-until-authoritative-period' &&
            ['mall_goods', 'mall_pay_goods'].some((name) =>
                tables
                    .get(name)
                    .some(
                        (entry) =>
                            entry.goodsId === row.goodsId &&
                            entry.refreshType === row.refreshType &&
                            entry.refreshTypeParam === row.refreshTypeParam &&
                            entry.timelimit === row.timelimit,
                    ),
            ),
        'Mall refresh period source unavailable',
        ErrorCode.MallConfigError,
    )
    // TODO: the server supplies BeginTime's reset_time; no current client path
    // establishes what [21] means or the official period anchor. Do not infer a
    // 21-day cycle or reset saved counts using the local no-expiry window.
    return { start: 0, end: 0 }
}

export function* mallCommonTimeDefinitions(tables, configured = policy) {
    const ids = mallLocalTimeIds(tables, configured)
    if (!ids) return
    // Native PlayerMallGoods accepts 0/0, but CommonTimeManager does not:
    // IsShopStillOnline/IsShopRecommendStillOnline require start <= now <= end.
    // The bounded display interval is local policy, not an official expiry.
    const window = configured.networkDisplayWindow
    ensure(
        window?.start === '0' &&
            typeof window.end === 'string' &&
            /^[1-9]\d*$/.test(window.end) &&
            Number.isSafeInteger(Number(window.end)) &&
            Number(window.end) <= 0xffffffff,
        'Invalid local mall common time interval',
        ErrorCode.GameConfig,
    )
    for (const id of ids)
        yield {
            time_id: id,
            start_time: window.start,
            end_time: window.end,
        }
}
