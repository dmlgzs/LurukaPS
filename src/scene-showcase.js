import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { appearanceCatalog } from './appearance.js'
import { petSkinIds } from './pet-skins.js'

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const validGuid = (v) =>
    (typeof v === 'string' || Number.isSafeInteger(v)) &&
    /^[1-9]\d{0,19}$/.test(String(v)) &&
    BigInt(v) <= 0xffffffffffffffffn
function structure(ok, message) {
    ensure(ok, message, ErrorCode.InvalidArgument)
}
function finite(v) {
    // Finite float32 is the client Vector coordinate domain; no arbitrary world bounds.
    return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3.4028234663852886e38
}
function vector(v, dimensions = ['x', 'y', 'z']) {
    structure(object(v) && dimensions.every((k) => finite(v[k])), 'Invalid scene showcase vector')
}
function unlocked(tables, state, condition) {
    if (condition === '' || condition === 0 || condition === undefined) return
    ensure(typeof condition === 'string', 'Invalid showcase unlock configuration', ErrorCode.GameConfig)
    for (const token of condition.split('|')) {
        const parts = token.split('#').map(Number)
        ensure(
            parts.length === 2 && parts.every(Number.isSafeInteger),
            'Malformed showcase unlock condition',
            ErrorCode.GameConfig,
        )
        ensure(parts[0] === 2004, 'Showcase condition type is not implemented', ErrorCode.FunctionClosed)
        ensure(
            tables.find('common_condition', parts[0])?.name === 'Level' && parts[1] > 0,
            'Invalid showcase level condition',
            ErrorCode.GameConfig,
        )
        const lv = state.player.basic_info.lv
        ensure(Number.isSafeInteger(lv) && lv > 0, 'Invalid saved player level', ErrorCode.GameConfig)
        ensure(lv >= parts[1], 'Scene showcase slot is locked', ErrorCode.FunctionClosed)
    }
}
export function sceneShowcaseSlot(tables, state, id) {
    structure(uint(id) && id > 0, 'Invalid scene showcase slot')
    const row = tables.find('photo_space_case', id)
    ensure(row, 'Scene showcase slot configuration missing', ErrorCode.GameConfig)
    unlocked(tables, state, row.unlock)
    return row
}
function configured(tables, table, id, state, unlockField = 'systemUnlock') {
    structure(uint(id) && id > 0, 'Invalid scene showcase configuration ID')
    const row = tables.find(table, id)
    ensure(row, 'Scene showcase component configuration missing: ' + table, ErrorCode.GameConfig)
    unlocked(tables, state, row[unlockField])
    return row
}
function parameters(tables, state, data, actionGroup, faceGroup) {
    for (const [field, group] of [
        ['actionId', actionGroup],
        ['faceId', faceGroup],
    ]) {
        const row = configured(tables, 'photograph_param', data[field], state)
        structure(row.groupId === group && row.show === 1, 'Scene showcase action category mismatch')
    }
    structure(finite(data.actionTime) && data.actionTime >= 0, 'Invalid scene showcase animation time')
}
function readJson(text) {
    structure(typeof text === 'string', 'Scene showcase requires nested JSON strings')
    let value
    try {
        value = JSON.parse(text)
    } catch {
        structure(false, 'Malformed scene showcase JSON')
    }
    structure(object(value), 'Invalid scene showcase JSON object')
    return value
}
export function validateSceneShowcase(tables, state, data, playerId) {
    structure(object(data), 'Missing scene showcase data')
    sceneShowcaseSlot(tables, state, data.id)
    // These are local storage/integrity limits, not claimed official text limits.
    structure(
        typeof data.name === 'string' && Buffer.byteLength(data.name) <= 256 && !/[\x00-\x1f]/u.test(data.name),
        'Invalid scene showcase name',
    )
    structure(typeof data.Cover === 'string' && Buffer.byteLength(data.Cover) <= 512, 'Invalid scene showcase cover')
    if (data.Cover !== '') {
        // situationManager.uploadCover sends the basename, not its CDN prefix or URL.
        const key = /^(\d+)_(\d+)_([0-9]+)$/.exec(data.Cover)
        structure(
            key && Number(key[1]) === data.id && Number(key[2]) === playerId,
            'Scene showcase cover belongs to another owner or slot',
        )
    }
    structure(
        typeof data.show_data === 'string' && Buffer.byteLength(data.show_data) <= 262144,
        'Scene showcase JSON exceeds local storage limit',
    )
    const content = readJson(data.show_data)
    const collections = [
        ['heroes', 1],
        ['objs', 2],
        ['pets', 3],
        ['stamps', 5],
    ]
    const allowed = new Set([...collections.map(([key]) => key), 'camera', 'env'])
    structure(
        Object.keys(content).every((key) => allowed.has(key)),
        'Unknown scene showcase collection',
    )
    const parsed = {}
    for (const [key, tab] of collections) {
        const cap = tables.get('situation_tab').find((r) => r.tabId === tab)?.number
        ensure(uint(cap) && cap > 0, 'Invalid showcase collection capacity', ErrorCode.GameConfig)
        // Lua encodes an empty table as [] or {} depending on bridge codec; pairs accepts both.
        const list = content[key]
        structure(
            Array.isArray(list) || (object(list) && Object.keys(list).length === 0),
            'Invalid scene showcase collection',
        )
        structure((Array.isArray(list) ? list.length : 0) <= cap, 'Too many scene showcase components')
        parsed[key] = Object.values(list).map(readJson)
    }
    const heroes = new Set()
    for (const hero of parsed.heroes) {
        const owned = state.player.heros_info.heros.find((h) => h.conf_id === hero.heroConfigId && !h.trail)
        ensure(owned, 'Scene showcase hero is not owned', ErrorCode.HeroNotExist)
        ensure(tables.find('hero', hero.heroConfigId), 'Showcase hero configuration missing', ErrorCode.GameConfig)
        structure(!heroes.has(hero.heroConfigId), 'Duplicate scene showcase hero')
        heroes.add(hero.heroConfigId)
        vector(hero.pos)
        vector(hero.rot)
        parameters(tables, state, hero, 5, 6)
        if (hero.clothingId !== undefined && hero.clothingId !== 0) {
            const skin = appearanceCatalog(tables).skins.get(hero.clothingId)
            structure(skin?.hero === hero.heroConfigId, 'Showcase hero clothing does not match hero')
            structure(
                hero.clothingId === hero.heroConfigId ||
                    (state.unlockedHeroSkins?.[hero.heroConfigId] ?? []).includes(hero.clothingId),
                'Showcase hero clothing is not owned',
            )
        }
    }
    const pets = new Set()
    for (const pet of parsed.pets) {
        structure(validGuid(pet.petGuid), 'Invalid showcase pet GUID')
        const owned = state.pets.find((p) => p.guid === String(pet.petGuid))
        ensure(owned, 'Scene showcase pet is not owned', ErrorCode.PetNotExist)
        structure(owned.config_id === pet.petConfigId, 'Showcase pet configuration does not match owned pet')
        ensure(tables.find('pet', pet.petConfigId), 'Showcase pet configuration missing', ErrorCode.PetConfNotExist)
        structure(!pets.has(String(pet.petGuid)), 'Duplicate scene showcase pet')
        pets.add(String(pet.petGuid))
        vector(pet.pos)
        vector(pet.rot)
        parameters(tables, state, pet, 12, 13)
        for (const key of ['specialParam', 'skinId', 'starColorId'])
            if (pet[key] !== undefined) structure(uint(pet[key]), 'Invalid showcase pet appearance value')
        if (pet.flashParam !== undefined)
            structure(typeof pet.flashParam === 'boolean', 'Invalid showcase pet flash flag')
        // Snapshot appearance follows this owned pet. It cannot grant rare variants.
        structure(
            (pet.specialParam ?? 0) === (owned.color ?? 0) &&
                (pet.flashParam ?? false) === [2, 3, 5].includes(owned.special ?? 0) &&
                (pet.starColorId ?? 0) === (owned.colorful ?? 0),
            'Showcase pet appearance does not match owned pet',
        )
        if (pet.skinId) {
            const skin = configured(tables, 'pet_skin', pet.skinId, state)
            ensure(
                skin.kiboId === owned.config_id,
                'Showcase pet skin does not match pet',
                ErrorCode.PetSkinNotMatchPet,
            )
            ensure(
                skin.isNormal === 1 || petSkinIds(tables, state).includes(pet.skinId),
                'Showcase pet skin not unlocked',
                ErrorCode.PetSkinNotActive,
            )
        }
    }
    for (const item of parsed.objs) {
        configured(tables, 'situation_objects', item.configId, state, 'unlock')
        vector(item.pos)
        vector(item.rot)
    }
    const indices = new Set()
    for (const stamp of parsed.stamps) {
        configured(tables, 'photograph_pic', stamp.configId, state)
        vector(stamp.pos, ['x', 'y'])
        structure(uint(stamp.index) && stamp.index > 0 && !indices.has(stamp.index), 'Invalid showcase stamp order')
        indices.add(stamp.index)
        structure(finite(stamp.scale) && stamp.scale > 0, 'Invalid showcase stamp scale')
    }
    const camera = readJson(content.camera),
        env = readJson(content.env)
    vector(camera.pos)
    vector(camera.targetPos)
    configured(tables, 'situation_scene', env.configId, state, 'unlock')
    // Keep the exact two-layer serialization: the Lua consumer decodes each string.
    return { id: data.id, name: data.name, Cover: data.Cover, show_data: data.show_data }
}
