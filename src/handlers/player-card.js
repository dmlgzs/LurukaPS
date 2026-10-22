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
