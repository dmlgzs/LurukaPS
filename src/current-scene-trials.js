import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

function members(tables, text, kind) {
    ensure(typeof text === 'string', 'Invalid current trial member list', ErrorCode.GameConfig)
    if (!text) return []
    const ids = new Set(),
        positions = new Set()
    const result = text.split('|').map((token) => {
        ensure(/^-?\d+#\d+$/.test(token), 'Invalid current trial member tuple', ErrorCode.GameConfig)
        const [position, id] = token.split('#').map(Number)
        ensure(
            (position === -1 || (Number.isInteger(position) && position >= 1 && position <= 3)) && positive(id),
            'Invalid current trial member identity or position',
            ErrorCode.GameConfig,
        )
        ensure(!ids.has(id), 'Duplicate current trial actor identity', ErrorCode.GameConfig)
        ensure(position === -1 || !positions.has(position), 'Duplicate current trial slot', ErrorCode.GameConfig)
        ids.add(id)
        positions.add(position)
        const config = tables.find(kind === 'hero' ? 'hero_interim' : 'pet_customized', id)
        ensure(config, 'Current trial actor configuration is missing', ErrorCode.GameConfig)
        if (kind === 'hero')
            ensure(
                positive(config.heroId) && tables.find('hero', config.heroId),
                'Current trial hero prototype is missing',
                ErrorCode.HeroNotExist,
            )
        else {
            ensure(
                positive(config.petId) && tables.find('pet', config.petId),
                'Current trial pet prototype is missing',
                ErrorCode.PetConfNotExist,
            )
            ensure(
                tables.find('template_value', config.petId),
                'Current trial pet attributes are missing',
                ErrorCode.GameConfig,
            )
        }
        // Current heropet_interim_group stores 1-based fixed slots. -1 is an
        // automatic placement request and must survive until formation layout.
        return { pos: position === -1 ? -1 : position - 1, id }
    })
    ensure(result.length <= 3, 'Too many current trial actors', ErrorCode.GameConfig)
    return result
}

// FormationManager.ReqChangeTrialFormation (1.0.0, 06029a3c) sends only
// open/trialId. This is current table data, never a client-supplied old roster.
// Authorization belongs to the caller's current scene/task controller.
export function resolveCurrentTrialGroup(tables, groupId) {
    ensure(positive(groupId), 'Invalid current trial group identity', ErrorCode.InvalidArgument)
    const row = tables.find('heropet_interim_group', groupId)
    ensure(row, 'Current trial group configuration is missing', ErrorCode.GameConfig)
    ensure(row.force === 0 || row.force === 1, 'Invalid current trial force mode', ErrorCode.GameConfig)
    const heroes = members(tables, row.hero_id, 'hero'),
        pets = members(tables, row.pet_id, 'pet')
    ensure(heroes.length > 0, 'Current trial group has no heroes', ErrorCode.GameConfig)
    ensure(
        row.control === 0 || (positive(row.control) && heroes.some((hero) => hero.id === row.control)),
        'Current trial control is not a configured hero',
        ErrorCode.GameConfig,
    )
    // control is an interim hero ID, not a slot number. Zero remains the
    // group's default/no-explicit-selection marker; do not convert it to slot0.
    return { groupId, force: row.force === 1, heroes, pets, controlId: row.control }
}

export function currentSceneTrialRoster(tables, sceneOrMapId) {
    const scene = typeof sceneOrMapId === 'number' ? tables.find('dungeon_scene', sceneOrMapId) : sceneOrMapId
    if (!scene) return null
    const id = scene.trialsId
    if (id === undefined || id === 0) return null
    ensure(positive(id), 'Invalid current scene trial group reference', ErrorCode.GameConfig)
    return resolveCurrentTrialGroup(tables, id)
}
