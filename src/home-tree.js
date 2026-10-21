import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { technologyState } from './technology.js'

const catalogs = new WeakMap()
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const stages = [...tables.get('home_landscape_tree')].sort((a, b) => a.landscapeTreeStage - b.landscapeTreeStage)
    ensure(stages.length > 0, 'Missing landscape tree stages', ErrorCode.GameConfig)
    for (const [index, row] of stages.entries())
        ensure(
            row.landscapeTreeStage === index + 1 &&
                row.id === row.landscapeTreeStage &&
                Number.isSafeInteger(row.upNeedschedule) &&
                row.upNeedschedule >= 0 &&
                (index === 0 ? row.upNeedschedule === 0 : row.upNeedschedule > stages[index - 1].upNeedschedule),
            'Invalid landscape tree stage schedule',
            ErrorCode.GameConfig,
        )
    const categories = tables
        .get('home_technology_type')
        .map((row) => row.categroy)
        .sort((a, b) => a - b)
    ensure(
        categories.length === 3 && new Set(categories).size === 3,
        'Unsupported landscape tree categories',
        ErrorCode.GameConfig,
    )
    const nodes = tables.get('home_technology_tree').map((tree) => ({
        tree,
        rows: tables.get('home_technology').filter((row) => row.type === tree.id),
    }))
    ensure(
        nodes.every(({ tree, rows }) => categories.includes(tree.category) && rows.length > 0),
        'Missing landscape tree technology configuration',
        ErrorCode.GameConfig,
    )
    const value = { stages, categories, nodes }
    catalogs.set(tables, value)
    return value
}

export function homeTreeState(tables, state) {
    ensure(state.home, 'Home state missing', ErrorCode.GameConfig)
    const { stages } = catalog(tables)
    const tree = (state.home.tree ??= { stage: stages[0].landscapeTreeStage, is_new: false })
    ensure(
        stages.some((row) => row.landscapeTreeStage === tree.stage) && typeof tree.is_new === 'boolean',
        'Invalid saved landscape tree stage',
        ErrorCode.GameConfig,
    )
    return tree
}

export function homeTreePayload(tables, state) {
    const tree = homeTreeState(tables, state),
        tech = technologyState(tables, state)
    const { categories, nodes } = catalog(tables)
    // Match TechnologyStore.GetValidActivatedTechnologyNumByType: count the
    // activated node once if its current row supplies a recipe or buff. This
    // naturally excludes empty roots, not every automatic-unlock node.
    // TODO: verify official server tree attribution; the client computes this
    // count for the science UI, while HomeTree.process is server-provided.
    const counts = categories.map(() => 0)
    for (const { tree: node, rows } of nodes) {
        const level = tech.levels[node.id]?.level ?? 0
        ensure(Number.isSafeInteger(level) && level >= 0, 'Invalid activated technology level', ErrorCode.GameConfig)
        if (!level) continue
        const row = rows.find((row) => row.level === level)
        ensure(row, 'Activated technology row is missing', ErrorCode.GameConfig)
        if (String(row.newTechnologyProduct || '').length || String(row.buffId || '').length)
            counts[categories.indexOf(node.category)]++
    }
    // CBT3 PageHomeLandTree requires exactly four entries, reads the first
    // three, and has no observed fourth-category consumer in current tables.
    return {
        stage: tree.stage,
        process: counts.reduce((a, b) => a + b, 0),
        is_new: tree.is_new,
        sub_process: [...counts, 0],
    }
}

export function upgradeHomeTree(tables, state) {
    const payload = homeTreePayload(tables, state),
        tree = state.home.tree
    // No request GUID exists. An unfinished presentation acknowledgement is
    // the local replay barrier, completed through 6099.
    if (tree.is_new) return false
    const next = catalog(tables).stages.find((row) => row.landscapeTreeStage === tree.stage + 1)
    ensure(next, 'Landscape tree is at maximum stage', ErrorCode.HomeTreeLevelIsMax)
    ensure(
        payload.process >= next.upNeedschedule,
        'Insufficient activated landscape tree nodes',
        ErrorCode.HomeTreeProcessNotEnough,
    )
    tree.stage = next.landscapeTreeStage
    tree.is_new = true
    state.homeRevision = (state.homeRevision || 0) + 1
    return true
}
