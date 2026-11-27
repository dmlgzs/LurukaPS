import assert from 'node:assert/strict'
const [
    { createNormalStarterFixture },
    { normalCreatorDriver },
    { TaskGraphs, nodeConditions },
    { taskActions },
    { taskOverrideNodeIds },
    { enemyDefinition },
    { parsePetGuid },
    { isStarterPet },
    { taskEnemyPacks },
] = await Promise.all([
    import('./prefix-correction-fixture.js'),
    import('./prefix-correction-creator.js'),
    import('../src/tasks.js'),
    import('../src/task-scenes.js'),
    import('../src/task-action-data.js'),
    import('../src/enemy-state.js'),
    import('../src/pet-guid.js'),
    import('../src/pet-catalog.js'),
    import('../src/task-enemy-slots.js'),
])

export function reachNormalFirstPet(f, extraObserver = () => {}) {
    const graphs = new TaskGraphs(f.tables),
        actions = [],
        snapshots = new Map(),
        publishedActors = new Set()
    // Current GetServerPeriod06009233 reads this static cache (default0);
    // WorldParser10762/0601411b updates it from actual SCDayWeatherSync.weather.
    // This model never substitutes world.weather or simulates Native time ticks.
    let dayWeather = 0,
        evidence
    const observe = (packets) => {
        for (const packet of packets) {
            const descriptor = f.protocol.byId.get(packet.id)
            if (packet.id === 9103)
                for (const object of f.protocol.decode(descriptor.rsp, packet.payload).map_info?.objs ?? []) {
                    snapshots.set(object.obj_id, object)
                    for (const monster of object.expand_data?.battle_group?.monsters ?? [])
                        if (monster.uid) publishedActors.add(String(monster.uid))
                }
            if (packet.id === 11063)
                publishedActors.add(String(f.protocol.decode(descriptor.rsp, packet.payload).agent_uid))
            if (packet.id === 10762) dayWeather = f.protocol.decode(descriptor.rsp, packet.payload).weather
        }
        extraObserver(packets)
    }
    const call = (name, data = {}) => {
        const packets = f.call(name, data)
        observe(packets)
        return packets
    }
    const reply = (name, packets) => {
        const descriptor = f.protocol.byName.get('CSProto' + name),
            packet = packets.find((row) => row.id === descriptor.id)
        assert(packet, 'real response for ' + name)
        return f.protocol.decode(descriptor.rsp, packet.payload)
    }
    const cards = () =>
        f
            .state()
            .player.sbag_infos.items.filter((row) => row.itemid === 1000001)
            .reduce((sum, row) => sum + row.itemnum, 0)
    const move = (pos) => {
        const old = f.state().world.pos
        f.advanceMs(Math.max(1, Math.ceil((Math.hypot(pos.x - old.x, pos.y - old.y, pos.z - old.z) / 400) * 1000)))
        call('StateUpdate', {
            move_msg: {
                map_id: f.state().world.map_id,
                move: [{ uuid: f.currentGroup().control, info: { pos, timestamp: String(f.nowMs()) } }],
            },
        })
        assert.deepEqual(f.state().world.pos, pos)
    }
    const playStory = (id) => {
        const row = f.tables.find('story', id)
        assert(row)
        call('SetStoryId', { story_id: id, story_type: row.storyType, is_skip: false, tag: 0, param: 0 })
    }
    const perform = (taskId, node, phase) => {
        const graph = graphs.get(taskId)
        for (const union of taskActions(node, phase)) {
            const keys = Object.keys(union).filter((key) => key.startsWith('__type_'))
            assert.equal(keys.length, 1)
            const kind = keys[0],
                data = union[kind]
            actions.push({ taskId, node: node.id, phase, kind, data, localCompletionModel: true })
            if (kind === '__type_TaskOpenStoryData') playStory(data.storyId)
            else if (kind === '__type_TaskTransferBaseData') {
                const point = f.tables.find('world_borthpos', data.transferPointId)
                assert(point)
                call('EnterWorldMap', { map_id: point.cityId, point_id: point.id, task_id: taskId, node_id: node.id })
                assert.equal(f.state().world.point_id, point.id)
            } else if (kind === '__type_TaskTeamChangeData') {
                const rows = graph.controllers.filter(
                    (row) => row.__type_TaskTeamController && taskOverrideNodeIds(row).includes(node.id),
                )
                assert.equal(rows.length, 1)
                call('TrialGroupChange', { open: true, trial_id: rows[0].__type_TaskTeamController.trialsId })
            } else if (kind === '__type_TaskDelayData') f.advanceMs(Math.ceil(data.delayTime * 1000))
            else if (kind === '__type_TaskTriggerGuideData') {
                // Catch tutorial starts now; its actual completion6701 is sent
                // only after this test has really acquired the pet.
                if (data.guideId !== 1030) call('GuideUpdate', { id: data.guideId, sub_id: 0 })
            } else
                assert(
                    [
                        '__type_TaskCreatNPCExportData',
                        '__type_TaskDeleteNPCExportData',
                        '__type_TaskClearWorldData',
                        '__type_TaskPlayWorldCameraData',
                        '__type_TaskBlackData',
                        '__type_TaskDisableSystemFunctionByTaskBlockData',
                    ].includes(kind),
                    'unmodelled current action ' + kind,
                )
        }
    }
    try {
        const creator = normalCreatorDriver(f, observe)
        creator.reachPendingCreator()
        call('PlayerCustomData', {
            name: Buffer.from('FirstCapture').toString('base64'),
            wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 2 },
        })
        creator.finishCreatorActions()
        assert.equal(cards(), 1)
        assert.equal(f.state().pets.length, 0)
        assert.equal(f.state().tasks.find((row) => row.task_id === 106001).nodes[0].node_id, 63)
        for (let steps = 0; f.state().tasks.some((row) => row.task_id === 106001); steps++) {
            assert(steps < 8, 'bounded remaining current prologue')
            const task = f.state().tasks.find((row) => row.task_id === 106001),
                saved = task.nodes[0],
                node = graphs.get(106001).nodes.get(saved.node_id),
                q = { task_id: 106001, node_id: node.id }
            perform(106001, node, 'before')
            call('MultiTaskClientBefore', { task_params: [q] })
            if (node.nodeType === 50) {
                call('TaskFinish', { u32: 106001 })
                break
            }
            const conditions = nodeConditions(node)
            for (const [index, condition] of conditions.entries()) {
                assert.equal(condition.conditionId, 2519)
                const data = condition.__type_TaskConditionBaseData.__type_TaskCondActiveNPCTriggerData
                assert(data?.isNowCreate)
                const npc = data.npcData
                move({ x: npc.posX, y: npc.posY, z: npc.posZ })
                call('ClientBehaviourRecord', { key: 2519, args: [npc.createNpcId, 106001, node.id, index, 1] })
            }
            call('MultiTaskClientCondAfter', { task_params: [{ ...q, indexes: conditions.map((_, index) => index) }] })
            perform(106001, node, 'after')
            call('MultiTaskClientAfter', { task_params: [q] })
        }
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106001).count, 1)
        const task = f.state().tasks.find((row) => row.task_id === 106002)
        assert(task?.nodes.some((row) => row.node_id === 56))
        const node = graphs.get(106002).nodes.get(56),
            condition = nodeConditions(node).find((row) => row.conditionId === 2526),
            fractal = condition.__type_TaskConditionBaseData.__type_TaskCondFractalPetCatchData
        perform(106002, node, 'before')
        call('MultiTaskClientBefore', { task_params: [{ task_id: 106002, node_id: 56 }] })
        assert.equal(f.state().world.map_id, 102)
        assert.equal(f.state().world.point_id, 102001)
        assert.equal(taskEnemyPacks(f.tables, fractal.enemyData).length, 1)
        // Current TaskHelper0602f1d2 creates objType4/createNpcId locally;
        // EnemyUnit06008738 passes slot0 through GetMonsterUUID0600de6e,
        // GetUUID0600de6f and identity GetHeightEightID0600de70.
        const nativeTarget = ((4n << 56n) | BigInt(fractal.enemyData.createNpcId)).toString()
        const target = [...publishedActors].find((id) => id === nativeTarget) ?? nativeTarget,
            definition = enemyDefinition(f.tables, f.state(), target)
        assert.equal(definition.config_id, 310369)
        assert.equal(definition.pack_id, 310369)
        assert.equal(definition.object_id, fractal.enemyData.createNpcId)
        const published = snapshots.get(fractal.enemyData.createNpcId)
        const cm = published?.pos
        const position = cm
            ? { x: cm.x / 100, y: cm.y / 100, z: cm.z / 100 }
            : Object.fromEntries(
                  ['x', 'y', 'z'].map((axis) => [
                      axis,
                      Math.fround(Math.fround(fractal.enemyData['pos' + axis.toUpperCase()]) / 100),
                  ]),
              )
        assert(Object.values(position).every(Number.isFinite))
        move(Object.fromEntries(Object.entries(position).map(([key, value]) => [key, Math.trunc(value * 100)])))
        call('GetCatchPetInfo', { tar_id: [target], day_weather: dayWeather })
        const specimen = structuredClone(f.state().petCatchPreviews[target].profile)
        assert.equal(specimen.config_id, 500297)
        assert.equal(f.state().pets.length, 0)
        assert.equal(cards(), 1)
        const reservationRequest = f.frame('CatchPetCard', { client_param: '1', item_id: 1000001, is_create: true })
        const reserved = reply('CatchPetCard', f.dispatch(reservationRequest))
        assert(reserved.catch_key > 0)
        assert.equal(cards(), 0)
        assert.equal(reply('CatchPetCard', f.dispatch(reservationRequest)).catch_key, reserved.catch_key)
        assert.equal(cards(), 0)
        const request = f.frame('CatchPet', {
            tar_id: target,
            item_id: 1000001,
            day_weather: dayWeather,
            position,
            catch_key: reserved.catch_key,
        })
        const result = reply('CatchPet', f.dispatch(request))
        assert.equal(result.success, true)
        const pet = f.state().pets.find((row) => row.guid === result.guid)
        assert(pet)
        assert.equal(f.state().pets.length, 1)
        assert.equal(pet.config_id, 500297)
        const identity = parsePetGuid(pet.guid)
        assert.equal(identity.type, 2)
        assert.equal(identity.ownerId, f.state().player.basic_info.id)
        assert.equal(isStarterPet(pet, f.state()), false)
        assert.equal(f.state().petBoxes.length, 1)
        assert.equal(pet.box_id, 101)
        assert.deepEqual(pet.gene_infos, specimen.gene_infos)
        assert.deepEqual(pet.comprehension, specimen.comprehension)
        assert.equal(pet.grade, specimen.grade)
        assert.deepEqual(f.state().recordPets, [500297])
        const replay = reply('CatchPet', f.dispatch(request))
        assert.equal(replay.guid, pet.guid)
        assert.deepEqual(replay.rewards.rewards ?? [], [])
        assert.equal(f.state().pets.length, 1)
        call('CatchPetPlayOver', { tar_id: target, day_weather: dayWeather })
        call('ClientBehaviourRecord', { key: 2526, args: [106002, fractal.enemyData.createNpcId, fractal.uniKey, 2] })
        for (const id of fractal.storyIds ?? []) playStory(id)
        call('GuideUpdate', { id: 1030, sub_id: 0 })
        call('MultiTaskClientCondAfter', {
            task_params: [{ task_id: 106002, node_id: 56, indexes: nodeConditions(node).map((_, index) => index) }],
        })
        perform(106002, node, 'after')
        call('MultiTaskClientAfter', { task_params: [{ task_id: 106002, node_id: 56 }] })
        assert(
            f
                .state()
                .tasks.find((row) => row.task_id === 106002)
                .nodes.some((row) => row.node_id === 65),
        )
        assert.equal(cards(), 10, 'actual capture-node completion replenishes cards after the first was consumed')
        const guid = pet.guid
        f.login()
        assert.equal(f.state().pets.length, 1)
        assert.equal(f.state().pets[0].guid, guid)
        assert.deepEqual(f.state().recordPets, [500297])
        assert.equal(cards(), 10)
        evidence = {
            target,
            position,
            positionSource: cm
                ? 'published task-worldobj centimetres'
                : 'current TaskBaseOverrideData.vecPos0602ebdd local slot0 model; no Native physics claim',
            uidSource: publishedActors.has(nativeTarget)
                ? 'actual task actor publication'
                : 'current Native task local creation/GetUUID formula and admitted task context',
            dayWeather,
            catchKey: reserved.catch_key,
            petGuid: guid,
            basePetId: pet.config_id,
            petBox: pet.box_id,
            cardBefore: 1,
            cardReserved: 0,
            cardAfterNode: 10,
            finalNode: 65,
            localGuaranteedCatchPolicy: true,
        }
        return {
            graphs,
            call,
            reply,
            move,
            perform,
            playStory,
            cards,
            snapshots,
            publishedActors,
            evidence,
            dayWeather,
            currentDayWeather: () => dayWeather,
        }
    } finally {
        /* The owning progression test closes the memory Store. */
    }
}
