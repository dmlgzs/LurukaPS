import assert from 'node:assert/strict'
import { EntrustCatalog } from '../src/entrust.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { parseRewards } from '../src/rewards.js'
import { preparedSystemAccess } from '../src/system-access.js'

export const totalExperience = (tables, state) => {
    let total = state.player.basic_info.exp
    for (let level = 1; level < state.player.basic_info.lv; level++) total += tables.find('player_level', level).exp
    assert(Number.isSafeInteger(total))
    return total
}
const routes = new Map([
    [2, { map: 666, objects: [1000100, 1000010, 1200002, 1200004] }],
    [3, { map: 677, objects: [1000100, 1000010, 1200003, 1200004] }],
    [10101, { map: 646, objects: [1000100, 1200020, 1200021, 1200004] }],
])

// Existing current-source actual entry/waves/claim/exit inputs, shared by
// normal level gates. No GM/state mutation; HP and movement are local inputs.
export function currentEntrustInputModel(f, driver) {
    const catalog = new EntrustCatalog(f.tables),
        world = new WorldObjectCatalog(f.tables)
    const call = (name, value = {}) => driver.call(name, value)
    const stamina = () => BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val)
    const finish = (id, kind, pay) => {
        const expected = routes.get(id),
            config = catalog.get(id, kind),
            stages = catalog.stages(id, kind)
        assert.equal(config.scene.id, expected.map)
        assert.deepEqual(
            stages.map((stage) => stage.row.id),
            expected.objects,
        )
        assert.deepEqual(
            stages.map((stage) => stage.type),
            [13, 50, 50, 30],
        )
        const beforeRequests = f.requestCount(),
            beforeWorld = f.state().world,
            beforeStamina = stamina(),
            beforeExperience = totalExperience(f.tables, f.state())
        if (kind === 'material') {
            assert.equal(preparedSystemAccess(f.tables, f.state(), 1734), true)
            call('MultiCampaignCreate', { dungeon_id: config.dungeon.id, scene_type: 12 })
        } else call('EnterEntrust', { entrust_id: id })
        assert.equal(f.state().world.map_id, expected.map)
        assert.equal(f.state().entrust.run.battle_complete ?? false, false)
        assert.equal(f.state().entrust.run.star, 0)
        const instance = f.state().entrust.run.instance_id
        call('MapLoadFinish')
        if (config.city.type === 12) call('MultiCampaignPlayerLoaded')
        driver.move(world.object(expected.map, stages[0].row.id).pos)
        call('WorldObjInteract', {
            objs: [
                {
                    obj: { obj_id: stages[0].row.id, complete: true, state_data: { step: 0 } },
                    interact_type: 0,
                },
            ],
        })
        const targets = []
        for (const stage of stages.filter((row) => row.type === 50)) {
            assert.equal(f.state().entrust.run.stage_index, stage.index)
            const record = f.state().worldObjects[`${expected.map}:${stage.row.id}`].expand_data.battle_group,
                packs = f.tables
                    .find('world_enemy_group', stage.row.expandId)
                    .enemyList.split('|')
                    .filter(Boolean)
                    .map(Number)
            assert.equal(record.monsters.length, packs.length)
            call('TryCreateWorldObj', { objs: record.monsters.map((monster) => monster.uid) })
            for (const [index, monster] of record.monsters.entries()) {
                const target = monster.uid,
                    definition = enemyDefinition(f.tables, f.state(), target),
                    hp = f.state().combat.entities[target]?.hp ?? definition.max_hp
                assert.equal(definition.pack_id, packs[index])
                assert.equal(hp, definition.max_hp, 'fresh current wave must not inherit an earlier death')
                assert(hp > 1)
                for (const damage of [-1, -(hp - 1)]) {
                    f.advanceMs(2)
                    call('BattleInfoReduce', {
                        base_time: String(f.nowMs()),
                        uint64_dic: [f.currentGroup().control, target],
                        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: damage } }],
                    })
                }
                assert.equal(f.state().combat.entities[target].hp, 0)
                targets.push(target)
            }
        }
        assert.equal(f.state().entrust.run.battle_complete, true)
        const chest = catalog.chest(id, kind)
        let xp = 0
        if (pay) {
            const costs = parseRewards(chest.need)
            assert.deepEqual(costs, [{ itemtype: 10, itemid: 3, itemnum: 30 }])
            const advertisedXp = parseRewards(f.tables.find('dungeon_material', id).rewardShow)
                .filter((row) => row.itemtype === 10 && row.itemid === 10)
                .reduce((sum, row) => sum + row.itemnum, 0)
            assert.equal(advertisedXp, 300)
            const packets = call('StaminaBoxGet', { box_id: chest.id, times: 1 }),
                value = driver.reply('StaminaBoxGet', packets)
            xp = value.reward.rewards
                .filter((row) => row.itemtype === 10 && row.itemid === 10)
                .reduce((sum, row) => sum + row.itemnum, 0)
            assert.equal(xp, advertisedXp)
            assert.equal(stamina(), beforeStamina - 30n)
        } else {
            assert(f.state().entrust.records[id].entrust_star >= 1)
            assert.equal(stamina(), beforeStamina)
        }
        assert.equal(totalExperience(f.tables, f.state()) - beforeExperience, xp)
        call(config.city.type === 2 ? 'CampaignQuit' : 'MultiCampaignQuit')
        assert.equal(f.state().entrust.run, undefined)
        assert.equal(f.state().world.map_id, beforeWorld.map_id)
        assert.deepEqual(f.state().world.pos, beforeWorld.pos)
        return {
            id,
            kind: kind ?? 'entrust',
            instance,
            targets,
            paid: pay,
            xp,
            cost: pay ? 30 : 0,
            requests: f.requestCount() - beforeRequests,
            level: f.state().player.basic_info.lv,
            exp: f.state().player.basic_info.exp,
        }
    }

    return { finish, stamina }
}
