import assert from 'node:assert/strict'

// Bounded input model of the recovered3217420 ast_story_dungeon_ai_common
// graph0ad6d098...3137567. Not a general graph executor or Unity runtime.
const openingKeys = ['story_id_0', 'story_id_01', 'story_id_02', 'story_id_03', 'story_id_04']
const endingKeys = ['story_id_10', 'story_id_101', 'story_id_102', 'story_id_103', 'story_id_104', 'story_id_last']

export function currentCommonDungeonStoryPipeline(tables, mapId) {
    assert([6200, 6201].includes(mapId), 'Unqualified current scene')
    const scene = tables.find('dungeon_scene', mapId)
    assert.equal(
        tables.find('world_blueprint', scene.blueprintId).path,
        'Config/World/Graph/Blueprint/ast_story_dungeon_ai_common.asset',
    )
    const values = new Map()
    for (const token of [...String(scene.intParam).split('|'), ...String(scene.stringParam).split('|')]) {
        if (!token) continue
        const index = token.indexOf('#')
        assert(index > 0)
        const key = token.slice(0, index)
        assert(!values.has(key))
        values.set(key, token.slice(index + 1))
    }
    const stories = (keys) =>
        keys
            .map((key) => Number(values.get(key) ?? 0))
            .filter((id) => {
                assert(Number.isSafeInteger(id) && id >= 0)
                if (id) assert(tables.find('story', id))
                return id > 0
            })
    const phases = Array.from({ length: 10 }, (_, index) => {
        const suffix = index ? '_' + index : ''
        const language = values.get('finish_con_word' + suffix) ?? ''
        const condition = values.get('finish_con_intlist' + suffix) ?? ''
        const prefix = 'story_id_' + (index + 1)
        return {
            index,
            language,
            condition,
            stories: index < 9 ? stories([prefix, prefix + '1', prefix + '2', prefix + '3', prefix + '4']) : [],
        }
    })
    return { mapId, opening: stories(openingKeys), phases, ending: stories(endingKeys) }
}

export function runCurrentCommonStoryDungeon({ f, current, call, snapshot, defeat, enter, sceneIds }, events) {
    let info = enter()
    const beforeExperience = f.state().player.basic_info.exp
    const consume = (packets) => {
        if (packets.some((packet) => packet.id === 9505)) info = snapshot(packets)
        return packets
    }
    const rpc = (name, value) => consume(call(name, value))
    const record = (id) => {
        rpc('ClientBehaviourRecord', { key: 1004, args: [id, 1] })
        events.push({ kind: 'record1004', id, map: f.state().world.map_id })
    }
    const story = (id) => {
        const type = f.tables.find('story', id).storyType
        if (type === 2) {
            // FreedomDialogGroup.Play06005b0c invokes the external callback
            // immediately when every type_callback is0. Report6060 arrives
            // when the dialog actually stops; choose full completion before
            // the next combat input, without pretending it blocked gameplay.
            const rows = f.tables.get('story_convenient').filter((row) => row.story_id === id)
            assert(rows.length && rows.every((row) => row.type_callback === 0))
            record(id)
            current.playStory(id)
            events.push({ kind: 'watch6060', id, type, map: f.state().world.map_id })
        } else {
            assert([0, 3].includes(type))
            // ContinuousPlayStory binds storyRealEndCallback, not the earlier
            // StorySection end callback. Controller6060 precedes this callback.
            current.playStory(id)
            events.push({ kind: 'watch6060', id, type, map: f.state().world.map_id })
            record(id)
        }
    }
    let scenes = 0
    while (f.state().storyCampaign) {
        assert(scenes++ < sceneIds.length)
        const map = f.state().world.map_id
        assert.equal(info.cur_scene_id, map)
        const pipeline = currentCommonDungeonStoryPipeline(f.tables, map)
        pipeline.opening.forEach(story)
        for (const phase of pipeline.phases) {
            if (phase.language && phase.condition) {
                const [kind, spawner, ignored, object, count, ...extra] = phase.condition.split(',').map(Number)
                assert.deepEqual([kind, ignored, extra.length], [2500, 0, 0])
                assert(Number.isSafeInteger(count) && count > 0)
                const rows = f.tables
                    .get('worldmap_' + map)
                    .filter(
                        (row) =>
                            (!spawner || row.spawnerId === spawner) &&
                            (!object || row.id === object) &&
                            String(row.commonTag) === String(phase.index + 1),
                    )
                assert.equal(rows.length, count)
                for (const row of rows) consume(defeat(row.id))
                events.push({ kind: 'target-completed', map, index: phase.index, objects: rows.map((row) => row.id) })
            } else events.push({ kind: 'empty-target-fail-output', map, index: phase.index })
            phase.stories.forEach(story)
        }
        assert(pipeline.ending.length)
        pipeline.ending.forEach(story)
        const ids = info.scene_datas.map((row) => row.scene_id)
        assert.deepEqual(ids, sceneIds)
        const index = ids.indexOf(info.cur_scene_id)
        assert(index >= 0)
        if (index + 1 < ids.length) {
            const next = ids[index + 1]
            events.push({ kind: 'transmit9506', map, next })
            rpc('EnterDungeonScene', { scene_id: next, point_id: 0 })
            rpc('StartDungeonClientOk')
        } else {
            events.push({ kind: 'transmit9503', map })
            rpc('CampaignQuit')
        }
    }
    assert.equal(scenes, 2)
    assert.equal(f.state().storyCampaignClears[10010].count, 1)
    assert.equal(f.state().player.basic_info.exp - beforeExperience, f.tables.find('dungeon', 10010).userExp)
}
