// Genuine frozen515-request normal prerequisite; same RAMStore handed to caller, no saved checkpoint.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts =
    process.env.NORMAL_SUCCESSOR_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-successor-'))
fs.mkdirSync(artifacts, { recursive: true })
process.env.NORMAL_PROGRESSION_ARTIFACTS = artifacts
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [
    { reachNormal167 },
    { normalSuccessorFlow },
    { ErrorCode },
    { conditionValue, conditionSatisfied },
    { gridAnchor },
] = await Promise.all([
    import('./prefix-correction-startup.js'),
    import('./prefix-correction-flow.js'),
    import('../src/error-codes.js'),
    import('../src/tasks.js'),
    import('../src/home-grid.js'),
])

export function reachCurrent106012() {
    const context = reachNormal167()
    const { f, driver } = context
    const prefixRequests = f.requestCount()
    const localModels = []
    const homeOperations = []
    const amount = (id) =>
        f
            .state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((sum, row) => sum + row.itemnum, 0)
    const manufacture = (buildGuid, productId, count, costs) => {
        const before = costs.map(([id]) => ({ id, count: amount(id) }))
        driver.call('ProductStart', { build_guid: buildGuid, product_id: productId, count })
        costs.forEach(([id, perUnit], index) => assert.equal(amount(id), before[index].count - perUnit * count))
        const jobs = f.state().home.productionJobs[buildGuid]
        const job = jobs.find((row) => row.productId === productId && row.claimed === 0)
        assert(job)
        const finishMs = (job.start + job.seconds * job.count) * 1000
        f.advanceMs(Math.max(0, finishMs - f.nowMs()))
        const claim = { guid: buildGuid, product_guids: [job.guid] }
        const request = f.frame('ProductFinish', claim)
        const packets = f.dispatch(request)
        context.consume(packets)
        const response = driver.reply('ProductFinish', packets)
        assert((response.reward.rewards ?? []).length > 0)
        const afterClaim = f.store.load(f.session().id)
        // This is direct Game dispatch, below Server ReplayWindow. Once the
        // ordinary job was removed, both repeated selections reject here.
        assert.throws(
            () => f.dispatch(request),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.store.load(f.session().id), afterClaim, 'same-frame repeated direct call cannot grant twice')
        // Ordinary jobs have been removed; a NEW request for the stale GUID is
        // an invalid selection, unlike the explicit hatch-receipt contract.
        assert.throws(
            () => driver.call('ProductFinish', claim),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.store.load(f.session().id), afterClaim)
        homeOperations.push({
            productId,
            buildGuid,
            count,
            costs,
            seconds: job.seconds,
            claimed: response.reward.rewards,
            directSameFrameStaleSelectionRejected: true,
            newRequestStaleSelectionRejected: true,
        })
        return response.reward.rewards
    }
    assert.equal(f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id, 167)
    const flow = normalSuccessorFlow(f, driver, {
        guidedCompletion(condition, { node, taskId, index }) {
            const context = { taskId, nodeId: node.id, index }
            const alreadySatisfied = conditionSatisfied(condition, conditionValue(condition, f.state(), context))
            if (alreadySatisfied && node.id !== 194) return
            if (node.id === 158) {
                const station = f
                    .state()
                    .home.builds.find((row) => row.build_id === 10000 && row.status === 1 && row.locate)
                assert(station)
                const rewards = manufacture(station.guid, 710019, 1, [
                    [303000, 15],
                    [301000, 5],
                ])
                assert(rewards.some((row) => row.itemtype === 13 && row.itemid === 110011 && row.itemnum === 1))
                assert(
                    !conditionSatisfied(condition, conditionValue(condition, f.state(), context)),
                    'an unplaced building is not built',
                )
                const bag = f.state().home.inventory.find((row) => row.build_id === 110011)
                assert.equal(bag.total_num - bag.used_num, 1)
                const locate = {
                    block_id: 101,
                    anchor: 6488113,
                    direction: 0,
                    position: { x: -50, y: 0, z: -25 },
                    rotation: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 },
                    center: { x: 0, y: 0, z: 0 },
                }
                driver.call('BuildLocate', { guid: 0, build_id: 110011, build_level: 1, locate })
                const placed = f.state().home.builds.find((row) => row.build_id === 110011 && row.locate)
                assert(placed)
                assert.equal(placed.build_type, 2)
                assert.equal(f.state().home.inventory.find((row) => row.build_id === 110011).used_num, bag.used_num + 1)
                homeOperations.push({
                    building: 110011,
                    buildGuid: placed.guid,
                    locate,
                    source: 'manufactured-and-claimed-type13 inventory then native6105 new mode1',
                })
            } else if (node.id === 189) {
                const station = f
                    .state()
                    .home.builds.find((row) => row.build_id === 110011 && row.status === 1 && row.locate)
                assert(station)
                const before = amount(1000002)
                manufacture(station.guid, 501002, 5, [
                    [312001, 2],
                    [317001, 1],
                ])
                assert.equal(amount(1000002), before + 5)
            } else if (node.id === 188) {
                const candidates = f
                    .state()
                    .pets.filter(
                        (pet) =>
                            !pet.work_status &&
                            (!pet.hero_id || pet.hero_id === '0') &&
                            !(pet.roulette_pos > 0) &&
                            pet.guid !== f.state().world.mount,
                    )
                assert(candidates.length >= 3, 'three actual idle owned pets are required')
                const selected = candidates.slice(0, 3).map((pet) => pet.guid)
                const before = f.state().pets.map((pet) => pet.guid)
                for (const pet_guid of selected) driver.call('PetStationInHomeHub', { pet_guid, type: 0 })
                assert.deepEqual(
                    f.state().pets.map((pet) => pet.guid),
                    before,
                )
                for (const guid of selected)
                    assert.equal(f.state().pets.find((pet) => pet.guid === guid).work_status, 7)
                homeOperations.push({
                    hubStationed: selected,
                    source: 'current6552 type0; owned idle selection; no fabricated roster',
                })
            } else if (node.id === 165) {
                assert.equal(f.tables.find('home_fieldtype', 1).homeBuildingId, 20161)
                const coordinates = [
                    [-58, 10],
                    [-56, 10],
                    [-58, 12],
                    [-56, 12],
                ]
                const fields = []
                for (const [x, z] of coordinates) {
                    const locate = {
                        block_id: 102,
                        anchor: gridAnchor(x, z),
                        direction: 0,
                        position: { x, y: 0, z },
                        rotation: { x: 0, y: 0, z: 0 },
                        scale: { x: 1, y: 1, z: 1 },
                        center: { x: 0, y: 0, z: 0 },
                    }
                    const result = driver.reply('FieldOpen', driver.call('FieldOpen', { field_type: 1, locate }))
                    assert.equal(result.build_id, 20161)
                    fields.push(result.guid)
                }
                assert.equal(new Set(fields).size, 4)
                homeOperations.push({
                    fieldOpened: fields,
                    fieldType: 1,
                    coordinates,
                    source: 'current6113 InvokePlow;2x2 block102; no blueprint manufacture/grant',
                })
            } else if (node.id === 190) {
                const goods = f.tables.get('goods').find((row) => row.goodsId === 2010101)
                assert(goods)
                assert.equal(goods.item, '3#310001#1')
                assert.equal(goods.costId, '10#103#0')
                assert.equal(goods.goodsNum, 4)
                const before = amount(310001)
                driver.call('ShopBuyItems', {
                    shop_id: 200001,
                    items: [{ slot_id: 2010101, goods_id: 2010101, times: 4 }],
                })
                assert.equal(amount(310001), before + 4)
                homeOperations.push({
                    shop: 200001,
                    slot: 2010101,
                    goods: 2010101,
                    seedItem: 310001,
                    count: 4,
                    cost: 'current free permanent4 tutorial entry',
                })
            } else if (node.id === 191) {
                const fields = f
                    .state()
                    .home.builds.filter((row) => row.build_id === 20161 && row.locate && !row.crop_info.seed_id)
                assert.equal(fields.length, 4)
                const before = amount(310001)
                driver.call('FieldPlant', {
                    plant_info: fields.map((row) => ({ build_guid: row.guid, seed_id: 310001 })),
                })
                assert.equal(amount(310001), before - 4)
                for (const field of fields) {
                    driver.call('FieldWater', { build_guid: field.guid, is_pet: false })
                    // Existing explicitly local instantaneous annual-water
                    // model, not a reconstructed Native animation duration.
                    driver.call('WaterFinish', { build_guid: field.guid, is_pet: false })
                }
                homeOperations.push({
                    manuallyWatered: fields.map((row) => row.guid),
                    seed: 310001,
                    source: 'current6115/6116/6170; ordinary backend water model preserved, no growth acceleration',
                })
            } else if (node.id === 192 || node.id === 193) {
                const choice =
                    node.id === 192
                        ? {
                              product: 710018,
                              building: 100011,
                              costs: [
                                  [300000, 15],
                                  [303000, 5],
                              ],
                              x: -44,
                              z: -25,
                          }
                        : {
                              product: 710001,
                              building: 10011,
                              costs: [
                                  [300000, 15],
                                  [317001, 5],
                              ],
                              x: -36,
                              z: -25,
                          }
                const station = f
                    .state()
                    .home.builds.find((row) => row.build_id === 10000 && row.status === 1 && row.locate)
                assert(station)
                const rewards = manufacture(station.guid, choice.product, 1, choice.costs)
                assert(
                    rewards.some((row) => row.itemtype === 13 && row.itemid === choice.building && row.itemnum === 1),
                )
                const locate = {
                    block_id: 101,
                    anchor: gridAnchor(choice.x, choice.z),
                    direction: 0,
                    position: { x: choice.x, y: 0, z: choice.z },
                    rotation: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 },
                    center: { x: 0, y: 0, z: 0 },
                }
                driver.call('BuildLocate', { guid: 0, build_id: choice.building, build_level: 1, locate })
                assert(f.state().home.builds.some((row) => row.build_id === choice.building && row.locate))
                homeOperations.push({ building: choice.building, sourceProduct: choice.product, locate })
            } else if (node.id === 194) {
                const pot = f
                    .state()
                    .home.builds.find((row) => row.build_id === 100011 && row.status === 1 && row.locate)
                assert(pot)
                const material = amount(400101),
                    food = amount(9002901)
                assert(material >= 16)
                driver.call('CookRequest', {
                    build_guid: pot.guid,
                    cook_id: 1051,
                    cook_count: 4,
                    cook_material: [{ item_id: 400101, item_num: 4 }],
                })
                assert.equal(amount(400101), material - 16)
                const jobs = f.state().home.productionJobs[pot.guid]
                assert.equal(jobs.length, 1)
                const job = jobs[0]
                assert.equal(job.count, 4)
                f.advanceMs(Math.max(0, (job.start + job.seconds * job.count) * 1000 - f.nowMs()))
                const output = driver.reply(
                    'ProductFinish',
                    driver.call('ProductFinish', { guid: pot.guid, product_guids: [job.guid] }),
                )
                assert.equal(
                    output.reward.rewards
                        .filter((row) => row.itemid === 9002901)
                        .reduce((sum, row) => sum + row.itemnum, 0),
                    4,
                )
                assert.equal(amount(9002901), food + 4)
                homeOperations.push({
                    cookId: 1051,
                    pot: pot.guid,
                    count: 4,
                    material: { id: 400101, total: 16 },
                    grade: 1,
                    optionalCraftForCoverage: alreadySatisfied,
                    upgradeFraction: 0,
                    seconds: job.seconds,
                    rewards: output.reward.rewards,
                })
            } else if (node.id === 195) {
                const table = f
                    .state()
                    .home.builds.find((row) => row.build_id === 10011 && row.status === 1 && row.locate)
                assert(table)
                const food = amount(9002901),
                    gold = f.state().player.basic_info.gold
                assert(food >= 4)
                driver.call('AddPetFood', {
                    build_guid: table.guid,
                    operate_type: 1,
                    items: [{ itemtype: 3, itemid: 9002901, itemnum: 4 }],
                })
                assert.equal(amount(9002901), food - 4)
                assert.equal(f.state().player.basic_info.gold, gold)
                homeOperations.push({
                    diningTable: table.guid,
                    food: 9002901,
                    count: 4,
                    operation: 1,
                    source: 'current6540 type1 transfer actual inventory to owned table',
                })
            } else assert.fail('Current guided condition requires its real input: node' + node.id)
            assert(conditionSatisfied(condition, conditionValue(condition, f.state(), context)))
        },
        npcStoryCompletion(data, { node, call }) {
            if (data.storyTag <= 0) {
                const story = f.tables.find('story', data.storyId)
                assert.equal(story.isAuto, 1)
                if (story.storyType === 2) {
                    // Current FreedomDialogGroup06005b18 fixes type2/tag0;
                    // StoryManager resets click counter before its free branch.
                    call('SetStoryId', { story_id: data.storyId, story_type: 2, tag: 0, param: 0, is_skip: false })
                    localModels.push({ storyId: data.storyId, mode: 'automaticFreedom-finish', tag: 0, clicks: 0 })
                } else if (story.storyType === 1) {
                    const rows = f.tables.get('story_convenient').filter((row) => row.story_id === data.storyId)
                    assert(rows.length)
                    assert(rows.every((row) => !String(row.Next_ID ?? '') || /^\d+$/.test(String(row.Next_ID))))
                    if (
                        rows.every(
                            (row) =>
                                !row.Next_ID &&
                                [1, 2, 3, 4, 5].every((n) => !row[`Option${n}`] && !row[`Option${n}_GotoiD`]),
                        )
                    ) {
                        const tags = new Set(rows.map((row) => row.tag_id))
                        assert.equal(tags.size, 1, 'unlinked automatic rows must have one proven terminal tag')
                        const tag = [...tags][0]
                        assert(Number.isSafeInteger(tag) && tag >= 0)
                        call('SetStoryId', { story_id: data.storyId, story_type: 1, tag, param: 0, is_skip: false })
                        localModels.push({
                            storyId: data.storyId,
                            rows: rows.map((row) => row.id),
                            terminalTagInvariant: tag,
                            linksOrOptions: false,
                            clicks: 0,
                            model: 'current-source automatic complete; no row-order claim',
                        })
                        return
                    }
                    const ids = new Set(rows.map((row) => row.id))
                    const incoming = new Set(
                        rows
                            .flatMap((row) => [
                                Number(row.Next_ID),
                                ...[1, 2, 3, 4, 5].map((n) => row[`Option${n}_GotoiD`]),
                            ])
                            .filter((id) => ids.has(id)),
                    )
                    const roots = rows.filter((row) => !incoming.has(row.id))
                    assert.equal(roots.length, 1)
                    let current = roots[0],
                        clicks = 0
                    const route = []
                    for (;;) {
                        assert(current && !route.includes(current.id) && route.length < rows.length)
                        route.push(current.id)
                        const choices = [1, 2, 3, 4, 5].filter((n) => current[`Option${n}_GotoiD`] > 0)
                        assert(!current.option_unlockcondition)
                        const next = choices.length ? current[`Option${choices[0]}_GotoiD`] : Number(current.Next_ID)
                        if (choices.length) clicks++ // explicit first unlocked choice input
                        if (!next) break
                        assert(Number.isSafeInteger(next) && ids.has(next))
                        current = rows.find((row) => row.id === next)
                    }
                    call('SetStoryId', {
                        story_id: data.storyId,
                        story_type: 1,
                        tag: current.tag_id,
                        param: clicks,
                        is_skip: false,
                    })
                    localModels.push({ storyId: data.storyId, route, terminalTag: current.tag_id, clicks })
                } else {
                    assert.equal(story.storyType, 0)
                    driver.playStory(data.storyId)
                }
                return
            }
            assert.equal(node.id, 118)
            assert.equal(data.storyId, 51011891)
            assert.equal(data.storyTag, 1)
            const rows = f.tables.get('story_convenient').filter((row) => row.story_id === data.storyId)
            assert.equal(rows.length, 3)
            const entry = rows.find((row) => row.Option1_GotoiD && row.Option2_GotoiD)
            assert(entry && !entry.option_unlockcondition)
            const yes = rows.find((row) => row.id === entry.Option1_GotoiD)
            const wait = rows.find((row) => row.id === entry.Option2_GotoiD)
            assert.equal(yes.tag_id, data.storyTag)
            assert.equal(wait.tag_id, 2)
            // Fresh automatic dialogue + one actual choice click: Native
            // counter0 ->1 and current data.tag_id -> controller EndTag.
            call('SetStoryId', { story_id: data.storyId, story_type: 1, tag: wait.tag_id, param: 1, is_skip: false })
            assert.equal(f.state().tasks.find((row) => row.task_id === 106010).nodes[0].node_id, 118)
            // Wrong positive tag must not issue the NPC-completion9904.
            call('SetStoryId', { story_id: data.storyId, story_type: 1, tag: yes.tag_id, param: 1, is_skip: false })
            localModels.push({
                storyId: data.storyId,
                entry: entry.id,
                selectedOption: 1,
                terminal: yes.id,
                EndTag: yes.tag_id,
                uiClickCount: 1,
                rejectedOptionTag: wait.tag_id,
            })
        },
        playableCompletion(data, { call }) {
            assert.equal(data.playableId, 62102)
            const row = f.tables.find('playable', data.playableId)
            assert.equal(row.stepMax, 10)
            assert.equal(row.stepRewards, '')
            const origin = { x: data.playableData.posX, y: data.playableData.posY, z: data.playableData.posZ }
            driver.move(origin)
            const petsBefore = f.state().pets.map((pet) => pet.guid),
                cardsBefore = driver.cards()
            const mountBefore = { status: f.state().world.status, mount: f.state().world.mount }
            call('PlayableStart', { u32: row.id })
            const beforePrematureFinish = f.store.load(f.session().id)
            assert.throws(
                () => call('PlayableFinish', { playId: row.id, score: 1, pos: { x: 0, y: 0, z: 0 } }),
                (error) => error.code === ErrorCode.InvalidArgument && /not completed/.test(error.message),
            )
            assert.deepEqual(f.store.load(f.session().id), beforePrematureFinish)
            // Current typed62102 + graph362052: RideLocalMount500072 is local,
            // suppresses9116 and bypasses owned9117. Eight actual point tags are
            // represented by distinct local references, never owned assets.
            const pointRefs = Array.from({ length: 8 }, (_, index) => Object.freeze({ tag: 'point', index }))
            const pending = new Set(pointRefs)
            let count = 0
            const collide = (ref) => {
                if (pending.delete(ref)) count++
            }
            collide(pointRefs[0])
            collide(pointRefs[0])
            assert.equal(count, 1)
            for (const ref of pointRefs.slice(1)) collide(ref)
            assert.equal(count, 8)
            f.advanceMs(1000) // explicit positive elapsed1s, below both100/300 bounds
            localModels.push({
                playableId: row.id,
                blueprintId: 362052,
                graphSha256: 'ab7b942ef631cf2bb3a6d0b597078f5aedd67bfd00c87d94c38f60c65ed91863',
                localMountConfig: 500072,
                ownedMountRpcUsed: false,
                circleTriggers: 8,
                duplicateCounts: false,
                elapsedSeconds: 1,
                rewardTier: 1,
                finishRewardPosition: 'initial-Vector3-zero',
                unityPhysicsRun: false,
            })
            call('PlayableStep', { playId: row.id, is_step: true, finish_step: row.stepMax, pos: origin })
            assert.equal(f.state().playableRuns[row.id].status, 2)
            const request = { playId: row.id, score: 1, pos: { x: 0, y: 0, z: 0 } }
            call('PlayableFinish', request)
            assert.equal(f.state().playableFinishes[row.id].score, 1)
            call('PlayableFinish', request)
            assert.deepEqual(
                f.state().pets.map((pet) => pet.guid),
                petsBefore,
            )
            assert.equal(driver.cards(), cardsBefore)
            assert.deepEqual({ status: f.state().world.status, mount: f.state().world.mount }, mountBefore)
        },
    })
    let transferred = false
    try {
        for (let count = 0; f.state().tasks.some((row) => row.task_id === 106010); count++) {
            assert(count < 36, 'bounded current167 through real106010 end')
            flow.step(106010)
        }
        assert.equal(
            f.state().taskRecords.some((row) => row.task_id === 106010),
            true,
        )
        assert.deepEqual(
            flow.visits.map((row) => row.nodeId),
            [
                167, 100, 103, 200, 118, 121, 176, 180, 108, 198, 199, 155, 127, 179, 158, 189, 188, 178, 196, 197, 165,
                190, 191, 192, 193, 194, 195, 133, 140, 157, 142,
            ],
        )
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106010).count, 1)
        const cookProtocolId = f.protocol.byName.get('CSProtoCookRequest').id
        assert.equal(
            f
                .requestIds()
                .slice(prefixRequests)
                .filter((id) => id === cookProtocolId).length,
            1,
            'actual optional10201 craft must execute even when existing food already satisfies194',
        )
        assert(homeOperations.some((row) => row.cookId === 1051))
        const stable = {
            pets: f.state().pets.map((pet) => pet.guid),
            fields: f
                .state()
                .home.builds.filter((row) => row.build_id === 20161)
                .map((row) => row.guid),
            counts: f.state().home.craftCounts,
            points: [...f.state().world.points],
        }
        context.consume(f.coldLogin())
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106010).count, 1)
        assert.deepEqual(
            f.state().pets.map((pet) => pet.guid),
            stable.pets,
        )
        assert.deepEqual(
            f
                .state()
                .home.builds.filter((row) => row.build_id === 20161)
                .map((row) => row.guid),
            stable.fields,
        )
        assert.deepEqual(f.state().home.craftCounts, stable.counts)
        assert.deepEqual(f.state().world.points, stable.points)
        transferred = true
        return { ...context, successorFlow: flow, homeOperations, localModels, artifacts }
    } finally {
        fs.writeFileSync(
            path.join(artifacts, 'successor.json'),
            JSON.stringify(
                {
                    sourceBoundary:
                        'genuine fresh normal account prefix; explicit local client model; no direct task/owned/point checkpoint writes',
                    prefixRequests,
                    successorRequests: f.requestCount() - prefixRequests,
                    visits: flow.visits,
                    actions: flow.actions,
                    localModels,
                    homeOperations,
                    assets: {
                        home: f.state().home,
                        items: f.state().player.sbag_infos.items,
                        gold: f.state().player.basic_info.gold,
                        diamond: f.state().player.basic_info.diamond,
                    },
                    final: f.summary(),
                },
                null,
                2,
            ) + '\n',
        )
        if (!transferred) f.close()
    }
}
