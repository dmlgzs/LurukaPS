import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petGrade } from './pets.js'
function integerConstant(tables, title) {
    const n = Number(tables.get('game').find((r) => r.title === title)?.value)
    ensure(Number.isInteger(n) && n > 0, 'Invalid ' + title, ErrorCode.GameConfig)
    return n
}
export function planGeneFruit(tables, state, pet, r) {
    const fruit = tables.find('pet_feed_item', r.item_id)
    ensure(fruit, 'Pet feeding item does not exist', ErrorCode.PetFeedItemNotExist)
    ensure(fruit.type === 3, 'Item is not a gene fruit', ErrorCode.InvalidArgument)
    ensure(fruit.isReuse === 0, 'Gene fruit reuse policy is unsupported', ErrorCode.FunctionClosed)
    const common = tables.find('common_item', r.item_id),
        dna = tables.find('pet_dna', fruit.dnaParam),
        skill = tables.find('skill', fruit.dnaParam)
    ensure(
        common && dna && skill && tables.get('skill_level').some((x) => x.skillId === fruit.dnaParam && x.level === 1),
        'Gene fruit definition unavailable',
        ErrorCode.GeneConfIsNull,
    )
    // Every current edible gene is numeric. Do not accept a future effect fruit
    // until its server/passive initialization contract is implemented.
    ensure(skill.skillType === 2, 'Effect gene fruit is not supported', ErrorCode.FunctionClosed)
    ensure(
        tables.find('skillsub_attrup', fruit.dnaParam),
        'Numeric gene effect configuration unavailable',
        ErrorCode.GeneConfIsNull,
    )
    ensure(Array.isArray(pet.gene_infos ?? []), 'Invalid saved gene list', ErrorCode.GameConfig)
    ensure(
        Number.isInteger(pet.ur_pos ?? 0) && (pet.ur_pos ?? 0) >= 0,
        'Invalid marked gene position',
        ErrorCode.GameConfig,
    )
    const max = integerConstant(tables, 'PET_DNA_MAX_NUM'),
        same = integerConstant(tables, 'PET_SAME_DNA_NUM'),
        limit = integerConstant(tables, 'NESTCOOP_DEVIANT_PETDNA_LIMIT'),
        genes = (pet.gene_infos ?? []).map((g) => ({ ...g })).sort((a, b) => a.pos - b.pos)
    ensure(
        genes.length <= max &&
            genes.every(
                (g, i) =>
                    g.pos === i + 1 &&
                    tables.find('pet_dna', g.gene_id) &&
                    Number.isInteger(g.gene_lv) &&
                    g.gene_lv > 0,
            ),
        'Invalid saved gene layout',
        ErrorCode.GameConfig,
    )
    const slot = r.slot_pos ?? 0
    ensure(
        Number.isInteger(slot) && slot >= 0 && slot <= max,
        'Invalid gene replacement slot',
        ErrorCode.InvalidArgument,
    )
    ensure(!pet.mutation_info?.pos, 'Pending mutation must be settled first', ErrorCode.InvalidLogic)
    let pos
    if (slot === 0) {
        ensure(genes.length < max, 'Gene slots are full; choose a replacement', ErrorCode.PetGeneAddFail)
        pos = genes.length + 1
    } else {
        ensure(
            genes.length === max && genes.some((g) => g.pos === slot),
            'Explicit replacement requires a full gene list',
            ErrorCode.InvalidArgument,
        )
        const old = tables.find('pet_dna', genes[slot - 1].gene_id)
        ensure(
            !(slot === 1 && old.talentDnaType === 1),
            'Innate character gene cannot be replaced',
            ErrorCode.PetCharacterDNACannotMutate,
        )
        ensure(
            pet.ur_pos !== slot,
            'Marked shining gene replacement requires appearance reconciliation',
            ErrorCode.FunctionClosed,
        )
        pos = slot
    }
    // 10832 has the historical enum name OldPetNotExist, but the CBT3 prompt is
    // 对应基因数量已满. It is the exact same-gene cap, not an ownership failure.
    ensure(
        genes.filter((g) => g.gene_id === fruit.dnaParam).length < same,
        'Same gene count has reached its limit',
        ErrorCode.OldPetNotExist,
    )
    if (dna.nestCoopTag === 1)
        ensure(
            genes.filter((g) => g.pos !== pos && tables.find('pet_dna', g.gene_id)?.nestCoopTag === 1).length < limit,
            'Deviant gene count reached its limit',
            ErrorCode.PetGeneAddFail,
        )
    const next = { pos, gene_id: fruit.dnaParam, gene_lv: 1 }
    if (slot) genes[slot - 1] = next
    else genes.push(next)
    const suppression = pet.suppress_lv ?? 0,
        force = BigInt(state.player.attr_infos.attrs.find((a) => a.attr_id === 22)?.attr_val ?? '0')
    ensure(Number.isInteger(suppression) && suppression >= 0, 'Invalid saved pet suppression', ErrorCode.GameConfig)
    if (BigInt(suppression) > force) {
        const row = tables.get('pet_level_decay').find((x) => x.lvDif === Number(BigInt(suppression) - force)),
            amount =
                row?.[
                    pet.original_type === 1
                        ? 'bossAttriDown'
                        : pet.original_type === 2
                          ? 'eliteAttriDown'
                          : 'normalAttriDown'
                ] ?? 0
        ensure(amount === 0, 'Suppressed pet cannot be fed', ErrorCode.InvalidLogic)
    }
    const favor = String(tables.get('game').find((x) => x.title === 'FRUIT_PET_FAVORABILITY_ONCE')?.value ?? '')
        .split('|')
        .map(Number)[common.rarity]
    ensure(Number.isSafeInteger(favor) && favor >= 0, 'Fruit favor configuration unavailable', ErrorCode.GameConfig)
    return { genes, grade: petGrade(tables, { ...pet, gene_infos: genes }), favor }
}
