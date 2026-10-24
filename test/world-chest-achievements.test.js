import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { isFieldChest } from '../src/world-chest-progress.js'
import { achievementCatalogue } from '../src/achievements.js'
import { achievementStateRule } from '../src/achievement-state-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const tiers = [3020014, 3020015, 3020016]
function fixture(name) {
    const f = achievementFixture(name),
        catalog = new WorldObjectCatalog(f.tables),
        live = catalog
            .get('worldmap_101')
            .find(
                (row) =>
                    !row.initialCompleteState &&
                    !row.appearCond &&
                    !row.disappearCond &&
                    row.statusReward &&
                    isFieldChest(f.tables, 101, catalog.find('world_spawner', row.spawnerId)),
            ),
        edit = (fn) => f.store.transact(f.session.id, 0, fn)
    assert(live)
    function legacy(count) {
        const receipts = {}
        for (const city of f.tables
            .get('world_city')
            .filter((row) => row.type === 1)
            .sort((a, b) => a.id - b.id)) {
            let rows
            try {
                rows = catalog.get('worldmap_' + city.id)
            } catch (error) {
                if (error.code === 'ENOENT') continue
                throw error
            }
            for (const row of rows) {
                if (row.cityId !== city.id || row.initialCompleteState || (city.id === 101 && row.id === live.id))
                    continue
                if (!isFieldChest(f.tables, city.id, catalog.find('world_spawner', row.spawnerId))) continue
                // A confirmed completed claim is lifetime evidence even if
                // the configured chest's reward list is empty, as in the
                // real producer. A reward preview is not the receipt.
                const drops = String(row.statusReward || '')
                    .split('|')
                    .filter((id) => Number(id) > 0)
                receipts[city.id + ':' + row.id] = {
                    obj_id: row.id,
                    complete: true,
                    claims: { complete: true, ...(drops.length ? { ['drop:' + (drops.length - 1)]: true } : {}) },
                    time: 1799999900,
                }
                if (Object.keys(receipts).length === count) break
            }
            if (Object.keys(receipts).length === count) break
        }
        assert.equal(Object.keys(receipts).length, count)
        edit((s) => {
            s.worldObjects = receipts
            delete s.worldChestHistory
        })
    }
    return { ...f, catalog, live, edit, legacy }
}

test('the three actual12072 thresholds use confirmed lifetime history and never create daily/weekly past events', () => {
    const f = fixture('chest-achievement-history')
    try {
        const model = achievementCatalogue(f.tables)
        assert(tiers.every((id) => model.rules.get(id).supported))
        assert.deepEqual(
            tiers.map((id) => model.byId.get(id).param),
            [20, 50, 100],
        )
        assert.equal(achievementStateRule([12072, 1, 20]), false)
        assert.equal(achievementStateRule([12072, 0, 20, 1]), false)
        f.legacy(20) // imported canonical receipts, not twenty actual test openings.
        const periods = structuredClone(f.state().dailyActive)
        f.call('ActivityGet')
        assert.equal(f.state().worldChestHistory.total, 20)
        assert.equal(f.state().achievements.entries[3020014].finishTime, 1800000000)
        assert.equal(f.state().achievements.entries[3020015].value, 20)
        assert.equal(f.state().achievements.entries[3020015].finishTime, 0)
        assert.deepEqual(f.state().dailyActive, periods)
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 3020014 }), 9902), { rewards: [], src: 20 })
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 3020014 }), 9902), { rewards: [] })
    } finally {
        f.store.close()
    }
})

test('99 imported old receipts plus one actual current chest claim complete all real tiers but credit only one present event', () => {
    const f = fixture('chest-achievement-real-producer')
    try {
        f.legacy(99)
        f.edit((s) => {
            s.world.map_id = 101
            s.world.pos = f.catalog.object(101, f.live.id).pos
        })
        const packets = f.call('WorldObjInteract', {
                objs: [{ obj: { obj_id: f.live.id, complete: true }, interact_type: 0 }],
            }),
            type = f.protocol.byName.get('CSProtoWorldObjInteract'),
            reply = f.protocol.decode(type.rsp, packets.find((row) => row.id === 9133).payload)
        assert(reply.objs[0].rewards.rewards.length > 0)
        assert.equal(f.state().worldChestHistory.total, 100)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        for (const id of tiers) {
            assert.equal(f.state().achievements.entries[id].value, achievementCatalogue(f.tables).byId.get(id).param)
            assert.equal(f.state().achievements.entries[id].finishTime, 1800000000)
            f.call('AchievementReward', { u32: id })
            assert(f.state().achievements.entries[id].claimed)
        }
        assert(packets.some((row) => row.id === 9900))
    } finally {
        f.store.close()
    }
})

test('migration, newly observed completion and claim all roll back on actual9900 encoding failure or a damaged counter', () => {
    const f = fixture('chest-achievement-rollback')
    try {
        f.legacy(20)
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoAchievementSync') throw Error('chest achievement9900 fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 3020014 }), /chest achievement9900 fault/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        f.edit((s) => {
            s.worldChestHistory = { version: 1, total: -1 }
        })
        const invalid = structuredClone(f.state())
        assert.throws(
            () => f.call('AchievementReward', { u32: 3020014 }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), invalid)
        f.edit((s) => {
            delete s.worldChestHistory
        })
        f.call('AchievementReward', { u32: 3020014 })
        assert(f.state().achievements.entries[3020014].claimed)
    } finally {
        f.store.close()
    }
})

test('an actually configured empty-reward chest still records one complete claim without fabricating loot or drop flags', () => {
    const f = fixture('chest-empty-reward-producer')
    try {
        let selected
        for (const city of f.tables.get('world_city').filter((row) => row.type === 1)) {
            let rows
            try {
                rows = f.catalog.get('worldmap_' + city.id)
            } catch (error) {
                if (error.code === 'ENOENT') continue
                throw error
            }
            const row = rows.find(
                (entry) =>
                    entry.cityId === city.id &&
                    !entry.initialCompleteState &&
                    !entry.appearCond &&
                    !entry.disappearCond &&
                    !entry.statusReward &&
                    isFieldChest(f.tables, city.id, f.catalog.find('world_spawner', entry.spawnerId)),
            )
            if (row) {
                selected = { map: city.id, row }
                break
            }
        }
        assert(selected, 'current configuration must supply a real empty-reward fixture')
        const { map, row } = selected
        f.edit((s) => {
            s.world.map_id = map
            s.world.pos = f.catalog.object(map, row.id).pos
        })
        const bag = structuredClone(f.state().player.sbag_infos),
            packets = f.call('WorldObjInteract', {
                objs: [{ obj: { obj_id: row.id, complete: true }, interact_type: 0 }],
            }),
            type = f.protocol.byName.get('CSProtoWorldObjInteract'),
            reply = f.protocol.decode(type.rsp, packets.find((packet) => packet.id === 9133).payload)
        assert.deepEqual(reply.objs[0].rewards.rewards, [])
        assert.equal(f.state().worldObjects[map + ':' + row.id].claims.complete, true)
        assert.equal(f.state().worldObjects[map + ':' + row.id].claims['drop:0'], undefined)
        assert.equal(f.state().worldChestHistory.total, 1)
        assert.equal(f.state().dailyActive.week.counts[12072], 1)
        assert.deepEqual(f.state().player.sbag_infos, bag)
    } finally {
        f.store.close()
    }
})
