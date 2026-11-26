import { appearanceCatalog, ensureAppearance } from './appearance.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function clothesPresetChannelCount(tables, clothingId, sex) {
    const clothing = appearanceCatalog(tables).clothes.get(clothingId)
    const id = Number(String(sex === 1 ? clothing?.maleColor : clothing?.femaleColor).split('|')[0])
    // Current TDColorFormulaTable.GetPresetColors(id,-1) appends only nonempty
    // color1..color5. Its exported primary key is capital Id, not id.
    const formula = tables.get('color_formula').find((row) => row.Id === id)
    ensure(formula, 'Clothing preset color configuration is unavailable', ErrorCode.ClothesColorConfValid)
    ensure(
        formula.sex === sex && formula.part === 1,
        'Clothing preset color configuration has the wrong sex or part',
        ErrorCode.GameConfig,
    )
    const count = [1, 2, 3, 4, 5].filter((index) => formula[`color${index}`]).length
    ensure(count > 0, 'Clothing has no color channels', ErrorCode.WardrobeColorNotExist)
    return count
}

// PageClothesPresetSave.RefreshPresetCells/GetFirstEmptyPresetId (current IL)
// has three slots per sex and clothing ID. It is not the face-preset store.
function normalizePreset(tables, value, saved = false) {
    const code = saved ? ErrorCode.GameConfig : ErrorCode.InvalidArgument
    ensure(
        value &&
            [1, 2].includes(value.sex) &&
            Number.isInteger(value.present) &&
            value.present >= 1 &&
            value.present <= 3,
        'Invalid clothing color preset identity',
        code,
    )
    const clothing = appearanceCatalog(tables).clothes.get(value.clothesid)
    ensure(
        clothing,
        'Clothing color preset configuration is unavailable',
        saved ? ErrorCode.GameConfig : ErrorCode.ClothesItemConfValid,
    )
    ensure(
        clothing.typeId === 1,
        'Clothing color preset requires a costume',
        saved ? ErrorCode.GameConfig : ErrorCode.ClothesTypeIdValid,
    )
    ensure(
        Array.isArray(value.parts) &&
            value.parts.length === 1 &&
            value.parts[0].type === 1 &&
            value.parts[0].id === value.clothesid,
        'Clothing color preset part does not match its clothing',
        code,
    )
    const part = value.parts[0]
    const colors = (part.colors ?? [])
        .map((color) => ({ index: color.index ?? 0, color_id: color.color_id ?? 0 }))
        .sort((a, b) => a.index - b.index)
    ensure(
        colors.length === clothesPresetChannelCount(tables, value.clothesid, value.sex) &&
            colors.every(
                (color, index) =>
                    color.index === index &&
                    Number.isInteger(color.color_id) &&
                    color.color_id >= 0 &&
                    color.color_id <= 0xffffffff,
            ),
        'Clothing color preset requires a complete unique color vector',
        code,
    )
    return { ...structuredClone(value), parts: [{ ...structuredClone(part), colors }] }
}

export function clothesPresetsSnapshot(tables, state) {
    const rows = state.clothesPresets ?? []
    ensure(Array.isArray(rows), 'Invalid clothing color preset storage', ErrorCode.GameConfig)
    const normalized = rows.map((row) => normalizePreset(tables, row, true))
    ensure(
        new Set(normalized.map((row) => `${row.sex}:${row.clothesid}:${row.present}`)).size === normalized.length,
        'Duplicate saved clothing color preset identity',
        ErrorCode.GameConfig,
    )
    return { info_list: normalized }
}

export function registerAppearancePresets(on) {
    on('PresetClothesInfoReq', (c, request) => {
        ensureAppearance(c.tables, c.state)
        const value = normalizePreset(c.tables, request)
        ensure(
            c.state.unlockedClothes.includes(value.clothesid),
            'Preset clothing is not unlocked',
            ErrorCode.ClothesNotUnlocked,
        )
        const rows = clothesPresetsSnapshot(c.tables, c.state).info_list
        const index = rows.findIndex(
            (row) => row.sex === value.sex && row.clothesid === value.clothesid && row.present === value.present,
        )
        if (index < 0) rows.push(value)
        else rows[index] = value
        c.state.clothesPresets = rows
        // OnPresetSaveConfirmed callback immediately rereads ModStore's palette
        // dictionary through RefreshCustomColorList, so publish before ACK.
        c.pushBefore('SCProtoPresetClothesInfoSync', { info_list: rows })
        return {}
    })
}
