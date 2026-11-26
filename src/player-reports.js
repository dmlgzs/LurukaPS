import { createHash } from 'node:crypto'
import policy from '../configs/player-report-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const dictionary = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogs = new WeakMap()
function limits(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const definitions = tables.get('complain_entry'),
        types = new Map()
    ensure(
        new Set(definitions.map((row) => row.id)).size === definitions.length,
        'Duplicate complaint entries',
        ErrorCode.GameConfig,
    )
    for (const row of tables.get('complain_type')) {
        ensure(
            uint(row.id) &&
                row.id > 0 &&
                !types.has(row.id) &&
                [0, 1].includes(row.isShow) &&
                typeof row.reportEntryID === 'string',
            'Malformed complaint type configuration',
            ErrorCode.GameConfig,
        )
        const ids = row.reportEntryID.split('|').map(Number)
        ensure(
            ids.length > 0 &&
                new Set(ids).size === ids.length &&
                ids.every((id) => uint(id) && id > 0 && definitions.some((entry) => entry.id === id)),
            'Missing or ambiguous complaint reason configuration',
            ErrorCode.GameConfig,
        )
        types.set(row.id, { enabled: row.isShow === 1, entries: new Set(ids) })
    }
    const read = (title) => Number(tables.get('game').find((row) => row.title === title)?.value),
        description = read('REPORT_USER_NUM'),
        cooldown = read('REPORT_COOLDOWN')
    ensure(
        Number.isSafeInteger(description) && description > 0 && uint(cooldown),
        'Invalid complaint limits',
        ErrorCode.GameConfig,
    )
    const result = { types, description, cooldown }
    catalogs.set(tables, result)
    return result
}
export function playerReportPolicy(value = policy) {
    ensure(
        dictionary(value) &&
            value.version === 1 &&
            value.origin === 'LOCAL' &&
            value.clientVersion === '1.0.0' &&
            value.packageVersion === 3217420 &&
            value.mode === 'persistent-local-receipt' &&
            value.forwarding === 'none' &&
            value.automaticPenalties === 'none' &&
            value.targetIdentity === 'existing-local-player' &&
            value.cooldown === 'per-account-report-type-current-table-seconds' &&
            value.deduplication === 'identical-request-within-cooldown' &&
            value.descriptionLengthUnit === 'utf16-code-units' &&
            [value.maxTargets, value.maxKiboGuids, value.maxSpecialDataBytes].every(
                (n) => Number.isSafeInteger(n) && n > 0,
            ),
        'Invalid local player-report policy',
        ErrorCode.GameConfig,
    )
    return value
}
function savedJournal(state) {
    const journal = state.localPlayerReports
    if (journal === undefined) return { version: 1, origin: 'LOCAL', next_id: 1, records: [], last_by_type: {} }
    ensure(
        dictionary(journal) &&
            journal.version === 1 &&
            journal.origin === 'LOCAL' &&
            Number.isSafeInteger(journal.next_id) &&
            journal.next_id > 0 &&
            Array.isArray(journal.records) &&
            dictionary(journal.last_by_type),
        'Malformed local complaint journal',
        ErrorCode.GameConfig,
    )
    const seen = new Set(),
        latestByType = new Map()
    for (const record of journal.records) {
        ensure(
            dictionary(record) &&
                Number.isSafeInteger(record.id) &&
                record.id > 0 &&
                record.id < journal.next_id &&
                !seen.has(record.id) &&
                record.origin === 'LOCAL' &&
                record.status === 'received-local' &&
                record.forwarded === false &&
                record.penalties_applied === false &&
                record.evidence_verification === 'unverified-client-report' &&
                uint(record.reporter_id) &&
                record.reporter_id > 0 &&
                uint(record.received_at) &&
                /^[0-9a-f]{64}$/.test(record.request_digest) &&
                dictionary(record.request) &&
                uint(record.request.report_type) &&
                record.request.report_type > 0 &&
                uint(record.request.entry_id) &&
                record.request.entry_id > 0 &&
                Array.isArray(record.request.player_ids) &&
                record.request.player_ids.length > 0 &&
                record.request.player_ids.every((id) => uint(id) && id > 0) &&
                typeof record.request.reason === 'string' &&
                typeof record.request.special_data === 'string' &&
                Array.isArray(record.request.kibo_guids) &&
                record.request.kibo_guids.every(
                    (id) => typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && BigInt(id) <= 0xffffffffffffffffn,
                ),
            'Malformed local complaint receipt',
            ErrorCode.GameConfig,
        )
        ensure(
            record.reporter_id === state.player.basic_info.id &&
                record.request_digest === createHash('sha256').update(JSON.stringify(record.request)).digest('hex'),
            'Complaint receipt identity or content mismatch',
            ErrorCode.GameConfig,
        )
        latestByType.set(
            record.request.report_type,
            Math.max(latestByType.get(record.request.report_type) ?? 0, record.received_at),
        )
        seen.add(record.id)
    }
    for (const [type, last] of Object.entries(journal.last_by_type))
        ensure(
            /^[1-9][0-9]*$/.test(type) &&
                uint(Number(type)) &&
                uint(last) &&
                journal.records.some(
                    (record) => record.request.report_type === Number(type) && record.received_at === last,
                ),
            'Malformed complaint cooldown record',
            ErrorCode.GameConfig,
        )
    for (const [type, latest] of latestByType)
        ensure(
            journal.last_by_type[type] === latest,
            'Complaint cooldown does not match retained receipts',
            ErrorCode.GameConfig,
        )
    return journal
}
export function submitPlayerReport(c, request, store, value = policy) {
    const local = playerReportPolicy(value),
        config = limits(c.tables),
        type = request.reportID
    ensure(uint(type) && config.types.get(type)?.enabled, 'Invalid complaint entry type', ErrorCode.ComplainInvalidType)
    const entry = request.reportEntryID
    ensure(uint(entry) && entry > 0, 'Select a complaint reason first', ErrorCode.ComplainNoEntry)
    ensure(
        config.types.get(type).entries.has(entry),
        'Complaint reason is not declared for this type',
        ErrorCode.ComplainInvalidEntry,
    )
    const targets = request.playerID
    ensure(
        Array.isArray(targets) &&
            targets.length > 0 &&
            targets.length <= local.maxTargets &&
            new Set(targets).size === targets.length,
        'Invalid complaint target list',
        ErrorCode.InvalidArgument,
    )
    ensure(
        targets.every((id) => uint(id) && id > 0 && id !== c.id && store.hasPlayer(id)),
        'Complaint target is not another local player',
        ErrorCode.InvalidTarget,
    )
    const reason = request.reason ?? '',
        special = request.special_data ?? '',
        guids = request.kiboGuids ?? []
    // The current sender writes a plain C# string, not base64 or bytes. JS
    // length has the same UTF-16 code-unit contract as String.Length.
    ensure(
        typeof reason === 'string' && reason.length <= config.description && reason.isWellFormed(),
        'Invalid complaint description',
        ErrorCode.InvalidArgument,
    )
    ensure(
        typeof special === 'string' &&
            special.isWellFormed() &&
            Buffer.byteLength(special, 'utf8') <= local.maxSpecialDataBytes &&
            (type === 2 || special === ''),
        'Invalid complaint evidence',
        ErrorCode.InvalidArgument,
    )
    ensure(
        Array.isArray(guids) && guids.length <= local.maxKiboGuids && (type === 6 || guids.length === 0),
        'Invalid complaint pet evidence',
        ErrorCode.InvalidArgument,
    )
    const kibo = guids.map((id) => {
        const text = String(id)
        ensure(
            /^[1-9][0-9]*$/.test(text) && BigInt(text) <= 0xffffffffffffffffn,
            'Invalid reported pet GUID',
            ErrorCode.InvalidArgument,
        )
        return BigInt(text).toString()
    })
    ensure(new Set(kibo).size === kibo.length, 'Repeated reported pet GUID', ErrorCode.InvalidArgument)
    ensure(uint(c.id) && c.id > 0 && uint(c.now), 'Invalid complaint reporter or clock', ErrorCode.GameConfig)
    const payload = {
            player_ids: [...targets],
            report_type: type,
            entry_id: entry,
            reason,
            special_data: special,
            kibo_guids: kibo,
        },
        digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        journal = savedJournal(c.state)
    const repeated = journal.records.findLast(
        (record) => record.request_digest === digest && c.now - record.received_at < config.cooldown,
    )
    if (repeated) return repeated.id
    const last = journal.last_by_type[type]
    ensure(
        last === undefined || c.now - last >= config.cooldown,
        'Complaint feature is cooling down',
        ErrorCode.ComplainCooldown,
    )
    ensure(journal.next_id < Number.MAX_SAFE_INTEGER, 'Local complaint identity exhausted', ErrorCode.GameConfig)
    const record = {
        id: journal.next_id,
        origin: 'LOCAL',
        status: 'received-local',
        forwarded: false,
        penalties_applied: false,
        evidence_verification: 'unverified-client-report',
        reporter_id: c.id,
        received_at: c.now,
        request_digest: digest,
        request: payload,
    }
    c.state.localPlayerReports = {
        ...journal,
        next_id: record.id + 1,
        records: [...journal.records, record],
        last_by_type: { ...journal.last_by_type, [type]: c.now },
    }
    return record.id
}
