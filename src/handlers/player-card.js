import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { playerCardSnapshot } from '../player-card-items.js'

// Error enum names for configuration slots are shifted relative to the current
// localized prompts. Match the actual prompt and table category, not the name.
const slots = {
    backboard: [202, ErrorCode.CardDressConfNoStandPlates, ErrorCode.CardDressBackBoardNone],
    baseboard: [201, ErrorCode.CardDressConfNoBackBoard, ErrorCode.CardDressBaseBoardNone],
    pet_accessory: [204, ErrorCode.CardDressConfNoBaseBoard, ErrorCode.CardDressPetAccessoryNone],
    role: [203, ErrorCode.CardDressConfNoPetAccessory, ErrorCode.CardDressStandPlatesNone],
    profile: [101, ErrorCode.CardDressConfNoProfile, ErrorCode.CardDressProfileNone],
    profile_frame: [102, ErrorCode.CardDressConfNoProFrame, ErrorCode.CardDressProFrameNone],
}
export function cardDecoration(tables, state, field, id) {
    const [type, missing, unowned] = slots[field]
    ensure(Number.isSafeInteger(id) && id > 0, 'Invalid player card decoration', missing)
    const row = tables.find('playercard_dress', id)
    ensure(row && row.type === type, 'Player card decoration category mismatch', missing)
    const owned = playerCardSnapshot(tables, state).bags.find((item) => item.config === id)
    ensure(owned, 'Player card decoration is not owned', unowned)
    return { row, owned }
}
export function registerPlayerCard(on, tables) {
    on('SetStandPlatesRole', (c, r) => {
        const row = tables.find('playercard_dress', r.config)
        ensure(row && row.type === 203, 'Custom role decoration configuration missing', ErrorCode.CardDressConfNone)
        ensure(row.customize === 1, 'Decoration is not a custom image slot', ErrorCode.NCardDressConfCustomZero)
        // pageStandeePreview sends the CDN object key, not an HTTP URL.
        // The namespace and owner/slot prefix come from photoStore.path and
        // uploadCapture; never download or execute the submitted object.
        ensure(
            typeof r.url === 'string' && Buffer.byteLength(r.url) <= 512,
            'Invalid custom role image key',
            ErrorCode.InvalidArgument,
        )
        const key = /^project-3\/playerdata\/standee\/hero\/(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/.exec(r.url)
        ensure(
            key && Number(key[1]) === c.id && Number(key[2]) === r.config,
            'Custom role image key belongs to another owner or slot',
            ErrorCode.InvalidArgument,
        )
        const heroId = Number(key[3])
        ensure(
            c.state.player.heros_info.heros.some((h) => h.conf_id === heroId && !h.trail),
            'Custom role image hero is not owned',
            ErrorCode.HeroNotExist,
        )
        const bags = playerCardSnapshot(tables, c.state).bags
        const item = bags.find((item) => item.config === r.config)
        if (item?.url === r.url) return {}
        if (item) item.url = r.url
        else bags.push({ config: r.config, url: r.url })
        c.state.playerCardRevision = (c.state.playerCardRevision ?? 0) + 1
        const basic = c.state.player.basic_info
        if (basic.stand_plates?.role?.config === r.config) {
            basic.stand_plates = { ...basic.stand_plates, role: { config: r.config, url: r.url } }
            syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { stand_plates: basic.stand_plates } })
        }
        return {}
    })
    on('ChangeStandPlates', (c, r) => {
        const basic = c.state.player.basic_info
        const stand = { ...basic.stand_plates }
        // Fresh profiles historically omit this structure. Derive missing slots
        // from the unique table defaults; never overwrite existing selections.
        for (const [field, [type]] of Object.entries(slots)) {
            if (stand[field] !== undefined && stand[field] !== null) continue
            const defaults = tables
                .get('playercard_dress')
                .filter((row) => row.type === type && row.defaultComponent === 1)
            ensure(defaults.length === 1, 'Player card category requires one table default', ErrorCode.GameConfig)
            stand[field] = field === 'role' ? { config: defaults[0].id, url: '' } : defaults[0].id
        }
        // Lua sends only profile or profile_frame for those edits. Omitted slots
        // must remain untouched; server-owned counts are never client editable.
        for (const field of Object.keys(slots)) {
            if (!Object.hasOwn(r, field)) continue
            const id = field === 'role' ? r.role?.config : r[field]
            const { row, owned } = cardDecoration(tables, c.state, field, id)
            if (field === 'role') {
                const url = owned.url ?? ''
                ensure(
                    row.customize !== 1 || url.length > 0,
                    'Custom player card image has not been saved',
                    ErrorCode.CardDressStandPlatesNone,
                )
                ensure(
                    (r.role.url ?? '') === url,
                    'Player card image does not match saved slot',
                    ErrorCode.InvalidArgument,
                )
                stand.role = { config: id, url }
            } else stand[field] = id
        }
        basic.stand_plates = stand
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { stand_plates: stand } })
        return {}
    })
}
