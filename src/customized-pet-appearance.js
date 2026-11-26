import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint32 = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const PetSpecialType = Object.freeze({ Colorful: 4, FlashColorful: 5 })
function appearancePairs(text, label) {
    return text.split('|').map((part) => {
        ensure(/^\d+#\d+$/.test(part), 'Malformed customized pet ' + label, ErrorCode.GameConfig)
        const values = part.split('#').map(Number)
        ensure(values.every(uint32), 'Malformed customized pet ' + label, ErrorCode.GameConfig)
        return values
    })
}

// Current ResolvePetCustomizedVariant06024070 only identifies a fixed override
// from one pair whose second integer is exactly100. It does not define a RNG.
export function customizedPetAppearanceDefinition(tables, config) {
    ensure(
        config &&
            typeof config.starColorParam === 'string' &&
            typeof config.colorParam === 'string' &&
            uint32(config.petskin) &&
            uint32(config.lightParam),
        'Malformed customized pet appearance',
        ErrorCode.GameConfig,
    )
    if (config.colorParam !== '') appearancePairs(config.colorParam, 'color')
    ensure(
        config.colorParam === '' && config.petskin === 0 && config.lightParam === 0,
        'Customized pet color, skin or light override is not implemented',
        ErrorCode.FunctionClosed,
    )
    if (config.starColorParam === '') return undefined
    const pairs = appearancePairs(config.starColorParam, 'star color')
    ensure(
        pairs.length === 1 && pairs[0][0] > 0 && pairs[0][1] === 100,
        'Customized pet star-color selection is not implemented',
        ErrorCode.FunctionClosed,
    )
    const colorful = pairs[0][0]
    ensure(
        tables.get('pet_color').filter((row) => row.starcolorId === colorful).length === 1,
        'Customized pet star-color configuration is unavailable or ambiguous',
        ErrorCode.GameConfig,
    )
    // starlinkCard is a separate unresolved source-to-wire contract. No card,
    // soul-link, worn-skin or light field is inferred by this initializer.
    const ordinaryGeneIds =
        config.dnaType === 1 && typeof config.dna === 'string'
            ? Object.freeze(config.dna.split('|').filter(Boolean).map(Number))
            : undefined
    const installedGeneIds =
        ordinaryGeneIds && [0, 1].includes(config.talentDnaType)
            ? Object.freeze([
                  ...new Set([...ordinaryGeneIds, ...(config.talentDnaType === 1 ? [config.talentDna] : [])]),
              ])
            : undefined
    return Object.freeze({ colorful, ordinaryGeneIds, installedGeneIds })
}

export function customizedPetAppearance(tables, definition, pet) {
    if (!definition) return {}
    const appearance = { colorful: definition.colorful }
    // Current ResolvePetCustomizedVariant reads the literal config.dna list,
    // not the independent talentDna and not an ID prefix. Only classify special
    // after those fixed ordinary genes have actually been installed. The current
    // wire enum is consumed by PetManager.LoadKiboModelByPetData06029bf2.
    if (
        pet?.color !== 0 ||
        !Array.isArray(pet.gene_infos) ||
        !Array.isArray(definition.ordinaryGeneIds) ||
        !Array.isArray(definition.installedGeneIds)
    )
        return appearance
    const actual = pet.gene_infos.map((gene) => tables.find('pet_dna', gene?.gene_id))
    if (actual.some((gene) => !gene)) return appearance
    const actualIds = new Set(actual.map((gene) => gene.id)),
        ordinary = definition.ordinaryGeneIds.map((id) => tables.find('pet_dna', id))
    if (
        actualIds.size !== actual.length ||
        actualIds.size !== definition.installedGeneIds.length ||
        !definition.installedGeneIds.every((id) => actualIds.has(id)) ||
        ordinary.some((gene) => !gene || !actualIds.has(gene.id))
    )
        return appearance
    appearance.special = ordinary.some((gene) => gene.rarity === 6)
        ? PetSpecialType.FlashColorful
        : PetSpecialType.Colorful
    return appearance
}
