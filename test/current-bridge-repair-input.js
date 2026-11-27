import assert from 'node:assert/strict'

// Source UI-confirm input for current ast_fsm_common_world_repair_item and
// RepairItemStateComponent. No Unity repair-effect animation is executed.
export function currentBridgeRepairInput(f, driver, data, events) {
    assert.equal(data.sceneId, f.state().world.map_id)
    assert.equal(data.status, 1)
    const row = f.tables.get('worldmap_' + data.sceneId).find((row) => row.id === data.npcId)
    assert(row)
    const fsm = f.tables.find('world_fsm', row.fsm)
    assert(fsm?.path.endsWith('/ast_fsm_common_world_repair_item.asset'))
    const values = new Map(
        fsm.intParam.split('|').map((token) => {
            const [key, value] = token.split('#')
            assert(key && Number.isSafeInteger(Number(value)))
            return [key, Number(value)]
        }),
    )
    assert(
        f.tables
            .find('world_blueprint', values.get('damage_blueprint'))
            ?.path.endsWith('/ast_playable_bridge_damage.asset'),
    )
    assert(
        f.tables
            .find('world_blueprint', values.get('repair_blueprint'))
            ?.path.endsWith('/ast_playable_bridge_repair.asset'),
    )
    const config = f.tables.find('common_world_repair', values.get('repair_consume_id'))
    assert(config && config.cityId === data.sceneId && config.worldmapId === row.id)
    const [type, item, count] = config.cost.split('#').map(Number)
    assert(type === 3 && item > 0 && count > 0 && !config.reward)
    const balance = () => f.state().player.sbag_infos.items.find((row) => row.itemid === item)?.itemnum ?? 0
    const before = balance()
    assert(before >= count, 'Actual normally earned bridge materials required')
    const point = f.tables.get('worldmap_' + data.sceneId).find((row) => row.id === values.get('repair_point_1'))
    assert(point)
    const [x, y, z] = point.position.split('|').map((value) => Math.round(Number(value) * 100))
    driver.move({ x, y, z })
    // Actual local interaction/UI confirmation is supplied as an input.
    // OpenRepairUI06030260 sends9139 with the overlaid recipe and root ID.
    const request = { repair_id: config.id, obj_id: row.id }
    const packets = driver.call('WorldCommonRepair', request)
    const sync = packets.find((packet) => packet.id === 9103)
    assert(sync)
    const payload = f.protocol.decode(f.protocol.byId.get(9103).rsp, sync.payload)
    assert.equal(payload.cmd, 2)
    const objects = payload.map_info.objs
    const root = objects.find((object) => object.obj_id === row.id)
    assert(root?.active && root.complete && root.state_data.step === 1)
    for (const [key, id] of values) {
        if (!/^(repair_obj|damage_obj|repair_point)_\d+$/.test(key)) continue
        assert.equal(objects.find((object) => object.obj_id === id)?.active, key.startsWith('repair_obj_'))
    }
    assert.equal(balance(), before - count)
    driver.call('WorldCommonRepair', request)
    assert.equal(balance(), before - count, 'Repeated confirm must not consume more materials')
    events.push({
        kind: 'current-bridge-repair',
        map: data.sceneId,
        object: row.id,
        recipe: config.id,
        spent: { item, count },
        before,
        after: balance(),
        delta: objects.map(({ obj_id, active }) => ({ obj_id, active })),
    })
}
