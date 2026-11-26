import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { tableExportManifest } from './table-source.js'
import { currentSceneTrialRoster } from './current-scene-trials.js'

// Existing supported route scope, not a dungeon/scene snapshot. Every scene,
// playable, birth point and trial actor below is joined from current tables.
const supported = new Set([10074])
const commonBlueprint = 'Config/World/Graph/Blueprint/ast_story_dungeon_ai_common.asset'
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => Number.isSafeInteger(value) && value > 0
const placements = new WeakMap()

export function isCurrentPlayableCampaign(id) {
    return supported.has(id)
}

export function currentPlayableCampaignCondition(text) {
    ensure(
        typeof text === 'string' && text.length > 0,
        'Current playable campaign condition is missing',
        ErrorCode.GameConfig,
    )
    const words = String(text ?? '').split('#'),
        values = words.map(Number)
    ensure(words[0] === '2525', 'Current playable campaign condition is unsupported', ErrorCode.FunctionClosed)
    ensure(words.length === 3, 'Malformed current playable campaign condition shape', ErrorCode.GameConfig)
    ensure(
        words.every((word) => /^(0|[1-9]\d*)$/.test(word)) && values.every(uint),
        'Malformed current playable campaign condition',
        ErrorCode.GameConfig,
    )
    ensure(values[0] === 2525, 'Current playable campaign condition is unsupported', ErrorCode.FunctionClosed)
    ensure(values[1] > 0 && values[2] > 0, 'Invalid current playable campaign target', ErrorCode.GameConfig)
    ensure(values[2] === 1, 'Repeated current campaign playable completion is unsupported', ErrorCode.FunctionClosed)
    return values
}

function graphPairs(text) {
    const result = new Map()
    for (const word of String(text ?? '')
        .split('|')
        .filter(Boolean)) {
        const index = word.indexOf('#'),
            key = word.slice(0, index)
        ensure(
            index > 0 && !result.has(key),
            'Malformed or duplicate current campaign graph parameter',
            ErrorCode.GameConfig,
        )
        result.set(key, word.slice(index + 1))
    }
    return result
}

function placement(tables, playId) {
    let cache = placements.get(tables)
    if (!cache) placements.set(tables, (cache = new Map()))
    if (cache.has(playId)) return cache.get(playId)
    const manifest = tableExportManifest(tables)
    ensure(manifest, 'Current campaign requires a complete map export', ErrorCode.GameConfig)
    const found = []
    for (const scene of tables.get('dungeon_scene')) {
        if (tables.find('world_city', scene.id)?.type !== 2 || !manifest.names.has('worldmap_' + scene.id)) continue
        // A declared current map file that is corrupt/missing must propagate.
        for (const row of tables.get('worldmap_' + scene.id)) {
            if (row.expandId !== playId) continue
            const spawner = tables.find('world_spawner', row.spawnerId)
            ensure(spawner, 'Current playable placement spawner is missing', ErrorCode.GameConfig)
            if (spawner.objectType !== 101) continue
            ensure(row.cityId === scene.id, 'Current playable placement scene mismatch', ErrorCode.GameConfig)
            found.push({ sceneId: scene.id, objectId: row.id })
        }
    }
    ensure(found.length > 0, 'Current campaign playable placement is missing', ErrorCode.InstanceSceneConfNotExist)
    ensure(found.length === 1, 'Current campaign playable placement is ambiguous', ErrorCode.GameConfig)
    cache.set(playId, found[0])
    return found[0]
}

export function currentPlayableCampaignRoute(tables, dungeon) {
    if (!supported.has(dungeon?.id)) return null
    const condition = currentPlayableCampaignCondition(dungeon.victoryCondition),
        playId = condition[1],
        configs = tables.get('playable').filter((row) => row.id === playId)
    ensure(
        configs.length === 1 && tables.find('playable_type', configs[0].type),
        'Current campaign playable configuration is missing or ambiguous',
        ErrorCode.GameConfig,
    )
    const play = configs[0]
    ensure(
        uint(play.stepMax) && [0, 1].includes(play.canReset) && [0, 1].includes(play.canRestart),
        'Malformed current campaign playable lifecycle',
        ErrorCode.GameConfig,
    )
    ensure(
        play.type === 16 && positive(play.stepMax) && play.canReset === 1 && play.canRestart === 1,
        'Current campaign playable lifecycle is unsupported',
        ErrorCode.FunctionClosed,
    )
    const selected = placement(tables, playId),
        scenes = tables.get('dungeon_scene').filter((row) => row.id === selected.sceneId)
    ensure(
        scenes.length === 1 && scenes[0].mapId === selected.sceneId,
        'Current campaign scene is missing or ambiguous',
        ErrorCode.InstanceSceneConfNotExist,
    )
    const scene = scenes[0],
        rows = tables.get('worldmap_' + scene.id)
    ensure(
        uint(scene.blueprintId) &&
            scene.blueprintId > 0 &&
            uint(scene.serverBlueprintId) &&
            uint(scene.enemyWaveSource),
        'Malformed current campaign graph references',
        ErrorCode.GameConfig,
    )
    const blueprints = tables.get('world_blueprint').filter((row) => row.id === scene.blueprintId)
    ensure(
        blueprints.length > 0,
        'Current campaign blueprint reference is missing',
        ErrorCode.InstanceSceneConfNotExist,
    )
    ensure(blueprints.length === 1, 'Current campaign blueprint reference is ambiguous', ErrorCode.GameConfig)
    const blueprint = blueprints[0]
    ensure(
        typeof blueprint.path === 'string' && blueprint.path.length > 0,
        'Current campaign blueprint path is missing',
        ErrorCode.GameConfig,
    )
    ensure(
        blueprint.path === commonBlueprint && scene.serverBlueprintId === 0 && scene.enemyWaveSource === 0,
        'Current campaign graph variant is unsupported',
        ErrorCode.FunctionClosed,
    )
    const points = tables.get('world_borthpos').filter((point) => point.cityId === scene.id && point.mainPoint === 1)
    ensure(points.length === 1, 'Current campaign birth point is missing or ambiguous', ErrorCode.NotFoundBirthPoint)
    tables.position(points[0])
    const strings = graphPairs(scene.stringParam),
        targetIds = [],
        used = new Set()
    for (const [key, word] of strings) {
        const slot = /^finish_con_word(?:_(\d+))?$/.exec(key)
        if (!slot || !word) continue
        ensure(
            !slot[1] || (/^[1-9]\d*$/.test(slot[1]) && Number(slot[1]) <= 9),
            'Current campaign target slot is unsupported',
            ErrorCode.FunctionClosed,
        )
        const suffix = slot[1] ? '_' + slot[1] : '',
            values = String(strings.get('finish_con_intlist' + suffix) ?? '')
                .split(',')
                .map(Number)
        ensure(
            values.length === 5 &&
                values.every(uint) &&
                values[0] === 2500 &&
                values[1] > 0 &&
                values[2] === 0 &&
                values[3] > 0 &&
                values[4] === 1 &&
                !used.has(values[3]),
            'Invalid current campaign interaction target',
            ErrorCode.GameConfig,
        )
        const targets = rows.filter((row) => row.id === values[3] && row.spawnerId === values[1])
        ensure(
            targets.length === 1 && tables.find('world_spawner', values[1])?.objectType === 13,
            'Current campaign interaction target is missing or unsupported',
            ErrorCode.GameConfig,
        )
        used.add(values[3])
        targetIds.push(values[3])
    }
    ensure(targetIds.length > 0, 'Current campaign interaction slots are missing', ErrorCode.GameConfig)
    const ints = graphPairs(scene.intParam),
        opening = Number(ints.get('story_id_0')),
        ending = Number(ints.get('story_id_last')),
        deleteTag = Number(ints.get('deleteItemTag1'))
    ensure(
        [opening, ending, deleteTag].every((value) => uint(value) && value > 0) &&
            rows.some((row) => String(row.commonTag) === String(deleteTag)),
        'Current campaign story or cleanup binding is missing',
        ErrorCode.GameConfig,
    )
    ensure(
        !rows.some((row) => tables.find('world_spawner', row.spawnerId)?.objectType === 50),
        'Mixed combat/current-playable campaign is unsupported',
        ErrorCode.FunctionClosed,
    )
    ensure(
        uint(scene.trialsId) &&
            scene.trialsId > 0 &&
            tables.get('heropet_interim_group').filter((row) => row.id === scene.trialsId).length === 1,
        'Current campaign trial group reference is missing or ambiguous',
        ErrorCode.GameConfig,
    )
    const roster = currentSceneTrialRoster(tables, scene)
    ensure(roster, 'Current campaign scene trial roster is missing', ErrorCode.GameConfig)
    return {
        mode: 'local_playable',
        scene_ids: [scene.id],
        opening_stories: [opening],
        local_condition: condition,
        playable_ids: [playId],
        ending_story: ending,
        delete_tag: deleteTag,
        target_ids: targetIds,
        trial_group_id: roster.groupId,
        playable_object_id: selected.objectId,
        source: 'current dungeon2525 + unique current playable placement and graph bindings',
    }
}

export function currentPlayableCampaignCount(tables, state) {
    const run = state.storyCampaign
    if (!run || !supported.has(run.dungeon_id) || ![2, 3].includes(run.status) || run.map_id !== state.world.map_id)
        return 0
    const dungeon = tables.find('dungeon', run.dungeon_id)
    ensure(dungeon, 'Current campaign dungeon configuration is missing', ErrorCode.DungeonConfNotExist)
    const route = currentPlayableCampaignRoute(tables, dungeon)
    ensure(
        Array.isArray(run.local_playable_condition) &&
            JSON.stringify(run.local_playable_condition) === JSON.stringify(route.local_condition),
        'Campaign completion policy changed; quit and re-enter',
        ErrorCode.InvalidLogic,
    )
    ensure(
        run.map_id === route.scene_ids[0] && JSON.stringify(run.playable_ids) === JSON.stringify(route.playable_ids),
        'Current campaign playable bindings are damaged',
        ErrorCode.GameConfig,
    )
    ensure(positive(run.instance_id), 'Current campaign instance is missing; quit and re-enter', ErrorCode.InvalidLogic)
    const receipts = run.playable_successes
    ensure(
        receipts === undefined || (receipts && typeof receipts === 'object' && !Array.isArray(receipts)),
        'Invalid current campaign success ledger',
        ErrorCode.GameConfig,
    )
    const receipt = receipts?.[route.local_condition[1]]
    if (receipt === undefined) return 0
    ensure(
        receipt &&
            positive(receipt.instance_id) &&
            positive(receipt.attempt_id) &&
            uint(receipt.map_id) &&
            uint(receipt.play_id),
        'Invalid current campaign playable success receipt',
        ErrorCode.GameConfig,
    )
    if (
        receipt.instance_id !== run.instance_id ||
        receipt.map_id !== run.map_id ||
        receipt.play_id !== route.local_condition[1]
    )
        return 0
    ensure(
        positive(run.next_playable_attempt) && receipt.attempt_id <= run.next_playable_attempt,
        'Current campaign success has no accepted attempt',
        ErrorCode.GameConfig,
    )
    // The existing Start -> Step(status2) -> Finish producer authenticates this
    // per-instance receipt. Historical finish flags and extra interaction slots
    // are not the current dungeon2525 completion predicate.
    return 1
}

export function currentPlayableCampaignSatisfied(tables, state) {
    return currentPlayableCampaignCount(tables, state) === 1
}
