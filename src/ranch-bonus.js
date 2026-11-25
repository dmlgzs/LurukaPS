import policy from '../configs/ranch-bonus-policy.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { ranchItem } from './ranch-items.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const u64 = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 0xffffffffffffffffn
const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const kinds = [3005, 3006]
const catalogs = new WeakMap()

export function ranchBonusEnabled() {
    ensure(
        object(policy) && policy.version === 1 && typeof policy.enabled === 'boolean',
        'Invalid ranch bonus policy',
        ErrorCode.GameConfig,
    )
    if (!policy.enabled) return false
    ensure(
        policy.approved === true && policy.officiallyVerified === false && policy.pendingLimit === 2,
        'Invalid ranch bonus policy authority',
        ErrorCode.GameConfig,
    )
    for (const [key, supported] of Object.entries({
        counter: 'committed-base-item-units-per-ranch',
        tier: 'enabled-descendant-replaces-ancestor',
        extraSelection: 'uniform-original-positions',
        surpriseSelection: 'normalized-relative-weights-guaranteed-one',
        upgradeCredit: 'keep-integer-units-next-base-only',
        pending: 'sealed-fifo-before-base',
        adoption: 'legacy-through-T-before-adopt-future-after-T',
        currencySlots: 'one-per-merged-currency',
        dailyReset: false,
        eggProducer: false,
        offlineAutoStorage: false,
    }))
        ensure(policy[key] === supported, 'Unsupported ranch bonus policy variant: ' + key, ErrorCode.FunctionClosed)
    return true
}
export function ranchBonusCatalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const tree = new Map(tables.get('home_technology_tree').map((row) => [row.id, row]))
    const baseIds = new Set(tables.get('pet_home_talent').flatMap((row) => list(row.farmProducts)))
    const baseDrops = [...baseIds].map((id) => {
        const row = tables.find('home_drop', id)
        ensure(
            positive(id) &&
                row &&
                positive(row.itemType) &&
                positive(row.minValue) &&
                positive(row.maxValue) &&
                row.maxValue >= row.minValue,
            'Invalid ranch base drop configuration',
            ErrorCode.GameConfig,
        )
        return row
    })
    // Current HomeDrop min/max values define each committed batch. The bonus
    // ledger counts item units, independently of the number of configured drops.
    ensure(
        baseDrops.length > 0 && baseDrops.every((row) => row.itemType === 3),
        'Unsupported ranch base item category',
        ErrorCode.FunctionClosed,
    )
    const maximumBaseQuantity = Math.max(...baseDrops.map((row) => row.maxValue))
    const definitions = []
    for (const row of tables.get('home_technology')) {
        const ids = list(row.buffId),
            params = String(row.buffParams ?? '').split('|')
        for (let index = 0; index < ids.length; index++) {
            if (!kinds.includes(ids[index])) continue
            ensure(
                positive(row.id) &&
                    positive(row.type) &&
                    positive(row.level) &&
                    tree.has(row.type) &&
                    !row.buffCondition &&
                    params.length === ids.length,
                'Invalid ranch bonus technology configuration',
                ErrorCode.GameConfig,
            )
            const tokens = params[index].split('#').map(Number),
                kind = ids[index]
            ensure(tokens.every(uint), 'Invalid ranch bonus numeric parameters', ErrorCode.GameConfig)
            ensure(tokens[0] === 10000, 'Unsupported ranch bonus parameter schema', ErrorCode.FunctionClosed)
            const threshold = kind === 3006 ? tokens[2] : tokens[1]
            ensure(positive(threshold), 'Invalid ranch bonus threshold', ErrorCode.GameConfig)
            ensure(
                kind === 3006 ? tokens.length === 3 : tokens.length >= 5 && tokens.length % 2 === 1 && tokens[2] === 0,
                'Unsupported ranch bonus parameter shape',
                ErrorCode.FunctionClosed,
            )
            const choices =
                kind === 3006
                    ? [{ dropId: tokens[1], weight: 1 }]
                    : tokens
                          .slice(3)
                          .flatMap((value, i, array) => (i % 2 === 0 ? [{ dropId: value, weight: array[i + 1] }] : []))
            for (const choice of choices) {
                ensure(
                    positive(choice.dropId) && positive(choice.weight),
                    'Invalid ranch bonus weighted choice',
                    ErrorCode.GameConfig,
                )
                const drop = tables.find('home_drop', choice.dropId),
                    items = list(drop?.itemId)
                ensure(
                    drop &&
                        [3, 10].includes(drop.itemType) &&
                        items.length &&
                        items.every(positive) &&
                        positive(drop.minValue) &&
                        positive(drop.maxValue) &&
                        drop.maxValue >= drop.minValue &&
                        drop.rate === 10000 &&
                        drop.dropTime === 0,
                    'Invalid ranch bonus output configuration',
                    ErrorCode.GameConfig,
                )
                ensure(kind === 3006 || items.length === 1, 'Unsupported surprise item pool', ErrorCode.FunctionClosed)
                for (const id of items)
                    ranchItem(tables, { itemtype: drop.itemType, itemid: id, itemnum: drop.minValue })
                choice.drop = drop
                choice.items = items
            }
            const weight = choices.reduce((sum, choice) => sum + choice.weight, 0)
            ensure(positive(weight), 'Ranch bonus weights overflow', ErrorCode.GameConfig)
            const fingerprint = createHash('sha256')
                .update(
                    JSON.stringify({
                        row: row.id,
                        kind,
                        params: params[index],
                        choices: choices.map((choice) => ({
                            dropId: choice.dropId,
                            weight: choice.weight,
                            items: choice.items,
                            itemType: choice.drop.itemType,
                            minValue: choice.drop.minValue,
                            maxValue: choice.drop.maxValue,
                        })),
                    }),
                )
                .digest('hex')
            definitions.push({
                id: row.id,
                type: row.type,
                level: row.level,
                kind,
                threshold,
                choices,
                weight,
                fingerprint,
            })
        }
    }
    ensure(
        definitions.length === 4 && kinds.every((kind) => definitions.filter((row) => row.kind === kind).length === 2),
        'Unsupported current ranch bonus family',
        ErrorCode.FunctionClosed,
    )
    for (const kind of kinds) {
        const thresholds = definitions.filter((row) => row.kind === kind).map((row) => row.threshold)
        ensure(
            Math.floor((Math.max(...thresholds) - 1 + maximumBaseQuantity) / Math.min(...thresholds)) <= 1,
            'Ranch bonus schema exceeds bounded pending model',
            ErrorCode.FunctionClosed,
        )
    }
    const descends = (from, to, seen = new Set()) => {
        if (from === to) return true
        if (seen.has(from)) return false
        seen.add(from)
        return list(tree.get(from)?.posttechnologyTypeId).some((next) => descends(next, to, seen))
    }
    const result = {
        definitions,
        byId: new Map(definitions.map((row) => [row.id, row])),
        baseDrops: new Map(baseDrops.map((row) => [row.id, row])),
        maximumBaseQuantity,
        descends,
    }
    catalogs.set(tables, result)
    return result
}
export function selectedRanchBonuses(tables, state) {
    const data = ranchBonusCatalog(tables),
        selected = new Map()
    for (const kind of kinds) {
        const active = data.definitions.filter(
            (row) => row.kind === kind && state.home?.technology?.levels?.[row.type]?.level === row.level,
        )
        const best = active.filter((row) => active.every((other) => data.descends(other.type, row.type)))
        ensure(
            best.length <= 1 && (!active.length || best.length === 1),
            'Unsupported ambiguous ranch bonus priority',
            ErrorCode.FunctionClosed,
        )
        if (best.length) selected.set(kind, best[0])
    }
    return selected
}
export function validateRanchBonus(tables, ranch) {
    const ledger = ranch.bonus
    if (ledger === undefined) return null
    ensure(
        object(ledger) &&
            ledger.version === 1 &&
            uint(ledger.adoptedAt) &&
            positive(ledger.epoch) &&
            object(ledger.families) &&
            Array.isArray(ledger.pendingBonus) &&
            ledger.pendingBonus.length <= 2 &&
            uint(ledger.lastBaseGuid) &&
            Array.isArray(ranch.drops) &&
            (ranch.claimedRewardGuids === undefined || Array.isArray(ranch.claimedRewardGuids)),
        'Malformed managed ranch bonus ledger',
        ErrorCode.GameConfig,
    )
    const data = ranchBonusCatalog(tables)
    ensure(Object.keys(ledger.families).length === 2, 'Invalid ranch bonus family ledger', ErrorCode.GameConfig)
    for (const kind of kinds) {
        const row = ledger.families[kind],
            definition = data.byId.get(row?.technologyId)
        ensure(
            object(row) &&
                typeof row.active === 'boolean' &&
                uint(row.creditUnits) &&
                uint(row.lastThreshold) &&
                typeof row.paramsFingerprint === 'string',
            'Invalid ranch bonus credit',
            ErrorCode.GameConfig,
        )
        ensure(
            row.lastThreshold === 0
                ? row.creditUnits === 0
                : data.definitions.some((item) => item.kind === kind && item.threshold === row.lastThreshold) &&
                      row.creditUnits < row.lastThreshold,
            'Invalid ranch bonus credit epoch',
            ErrorCode.GameConfig,
        )
        ensure(
            row.technologyId === 0
                ? !row.active && row.paramsFingerprint === ''
                : definition?.kind === kind && row.paramsFingerprint === definition.fingerprint,
            'Ranch bonus technology fingerprint differs',
            ErrorCode.GameConfig,
        )
    }
    const ids = new Set()
    for (const drop of ranch.drops) {
        ensure(
            object(drop) && positive(drop.guid) && !ids.has(drop.guid),
            'Duplicate ranch floor identity',
            ErrorCode.GameConfig,
        )
        ids.add(drop.guid)
    }
    for (const row of ledger.pendingBonus) {
        const definition = data.byId.get(row?.technologyId),
            choice = definition?.choices.find((item) => item.dropId === row?.drop_id)
        ensure(
            object(row) &&
                positive(row.guid) &&
                !ids.has(row.guid) &&
                u64(row.pet_guid) &&
                kinds.includes(row.family) &&
                definition?.kind === row.family &&
                row.paramsFingerprint === definition.fingerprint &&
                choice &&
                positive(row.triggerBaseGuid) &&
                row.triggerBaseGuid < row.guid &&
                positive(row.triggerBaseDropId) &&
                uint(row.triggeredAt) &&
                row.triggeredAt > ledger.adoptedAt,
            'Invalid sealed ranch bonus source',
            ErrorCode.GameConfig,
        )
        const item = ranchItem(tables, row.item)
        ensure(
            item.itemtype === choice.drop.itemType &&
                choice.items.includes(item.itemid) &&
                item.itemnum >= choice.drop.minValue &&
                item.itemnum <= choice.drop.maxValue,
            'Sealed ranch bonus differs from source',
            ErrorCode.GameConfig,
        )
        ids.add(row.guid)
    }
    ensure(
        Number.isSafeInteger(ranch.nextDropGuid) &&
            ranch.nextDropGuid > 0 &&
            ranch.nextDropGuid <= 0x100000000 &&
            [...ids, ledger.lastBaseGuid, ...(ranch.claimedRewardGuids ?? [])].every(
                (id) => uint(id) && id < ranch.nextDropGuid,
            ),
        'Invalid ranch identity high water',
        ErrorCode.GameConfig,
    )
    return ledger
}
export function adoptRanchBonus(tables, state, ranch, now) {
    ensure(ranch.bonus === undefined && uint(now), 'Invalid ranch bonus adoption', ErrorCode.GameConfig)
    ranch.bonus = {
        version: 1,
        adoptedAt: now,
        epoch: 1,
        lastBaseGuid: ranch.nextDropGuid - 1,
        families: Object.fromEntries(
            kinds.map((kind) => [
                kind,
                { technologyId: 0, paramsFingerprint: '', lastThreshold: 0, creditUnits: 0, active: false },
            ]),
        ),
        pendingBonus: [],
    }
    reconcileRanchBonuses(tables, state, ranch)
}
export function reconcileRanchBonuses(tables, state, ranch) {
    const ledger = validateRanchBonus(tables, ranch),
        selected = selectedRanchBonuses(tables, state)
    ensure(ledger, 'Missing ranch bonus adoption', ErrorCode.GameConfig)
    let changed = false
    for (const kind of kinds) {
        const definition = selected.get(kind),
            previous = ledger.families[kind]
        const next = definition
            ? { ...previous, technologyId: definition.id, paramsFingerprint: definition.fingerprint, active: true }
            : { ...previous, active: false }
        if (JSON.stringify(next) !== JSON.stringify(previous)) {
            ledger.families[kind] = next
            changed = true
        }
    }
    if (changed) {
        ensure(ledger.epoch < 0xffffffff, 'Ranch bonus epoch overflow', ErrorCode.GameConfig)
        ledger.epoch++
    }
    return changed
}
export function reserveRanchDropGuid(ranch) {
    ensure(
        Number.isSafeInteger(ranch.nextDropGuid) && ranch.nextDropGuid > 0 && ranch.nextDropGuid <= 0x100000000,
        'Invalid ranch identity allocator',
        ErrorCode.GameConfig,
    )
    ensure(ranch.nextDropGuid <= 0xffffffff, 'Ranch drop identity space exhausted', ErrorCode.InvalidLogic)
    const used = [
        ...ranch.drops.map((row) => row.guid),
        ...(ranch.bonus?.pendingBonus ?? []).map((row) => row.guid),
        ...(ranch.claimedRewardGuids ?? []),
    ]
    ensure(
        used.every((id) => positive(id) && id < ranch.nextDropGuid),
        'Ranch identity allocator would reuse a source',
        ErrorCode.GameConfig,
    )
    return ranch.nextDropGuid++
}
function roll(randomInt, maximum) {
    const value = randomInt(maximum)
    ensure(
        Number.isSafeInteger(value) && value >= 0 && value < maximum,
        'Invalid ranch bonus random result',
        ErrorCode.GameConfig,
    )
    return value
}
export function recordRanchBaseCommit(tables, state, ranch, base, at, randomInt) {
    const ledger = validateRanchBonus(tables, ranch)
    const source = ranchBonusCatalog(tables).baseDrops.get(base?.drop_id)
    ensure(
        ledger &&
            u64(base.pet_guid) &&
            positive(base.guid) &&
            positive(base.drop_id) &&
            source &&
            base.item.itemtype === source.itemType &&
            list(source.itemId).includes(base.item.itemid) &&
            positive(base.item.itemnum) &&
            base.item.itemnum >= source.minValue &&
            base.item.itemnum <= source.maxValue &&
            uint(at),
        'Invalid ranch base production fact',
        ErrorCode.GameConfig,
    )
    if (at <= ledger.adoptedAt || base.guid <= ledger.lastBaseGuid) return false
    ensure(ledger.pendingBonus.length === 0, 'Pending ranch bonus must precede new production', ErrorCode.GameConfig)
    ledger.lastBaseGuid = base.guid
    for (const kind of kinds) {
        const family = ledger.families[kind]
        if (!family.active) continue
        const definition = ranchBonusCatalog(tables).byId.get(family.technologyId),
            credit = family.creditUnits + base.item.itemnum
        const count = Math.floor(credit / definition.threshold)
        ensure(count <= 1, 'Ranch bonus count exceeds current schema', ErrorCode.GameConfig)
        family.creditUnits = credit % definition.threshold
        family.lastThreshold = definition.threshold
        if (!count) continue
        let choice = definition.choices[0]
        if (kind === 3005) {
            let pick = roll(randomInt, definition.weight)
            for (const row of definition.choices) {
                choice = row
                if (pick < row.weight) break
                pick -= row.weight
            }
        }
        const itemid = choice.items[kind === 3006 ? roll(randomInt, choice.items.length) : 0]
        const itemnum =
            choice.drop.minValue +
            (choice.drop.maxValue > choice.drop.minValue
                ? roll(randomInt, choice.drop.maxValue - choice.drop.minValue + 1)
                : 0)
        ledger.pendingBonus.push({
            guid: reserveRanchDropGuid(ranch),
            pet_guid: base.pet_guid,
            drop_id: choice.dropId,
            item: ranchItem(tables, { itemtype: choice.drop.itemType, itemid, itemnum }),
            family: kind,
            technologyId: definition.id,
            paramsFingerprint: definition.fingerprint,
            triggerBaseGuid: base.guid,
            triggerBaseDropId: base.drop_id,
            triggeredAt: at,
        })
    }
    ensure(ledger.pendingBonus.length <= 2, 'Ranch bonus queue overflow', ErrorCode.GameConfig)
    return true
}
