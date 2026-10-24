import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { nextOrnamentLevel } from '../src/ornament-upgrade.js'
import { grantRewards } from '../src/rewards.js'
import { playerIsInBattle, requirePlayerOutOfBattle } from '../src/player-battle-state.js'
import { ErrorCode } from '../src/error-codes.js'

// Synthetic group identities test graph/protocol semantics. These do not
// pretend to be actual client encounters or prove monster spawning.
const enemy = ((3n << 56n) | 12345n).toString()
function fixture(name) {
    const f = ornamentFixture(name),
        item = f.state().ornaments[0],
        plan = nextOrnamentLevel(f.tables, item)
    f.store.transact(f.session.id, 0, (s) => grantRewards(f.tables, s, plan.costs))
    return { ...f, guid: item.guid }
}
const inFight = (error) => error.code === ErrorCode.PlayerInFight
const node = (id, objects = [], players = []) => ({ id, target_obj_ids: objects, player_obj_ids: players })

test('6021 rejects an incoming10805 player relation before spending or changing the worn instance, then succeeds after the real reset', () => {
    const f = fixture('ornament-incoming-fight')
    try {
        f.call('ObjHatredIncSync', { inc: true, info: node(enemy, [], [f.session.id]) })
        const before = structuredClone(f.state())
        assert(playerIsInBattle(before))
        assert.throws(() => f.call('UpgradeOrnament', { u32: f.guid }), inFight)
        assert.deepEqual(f.state(), before)
        f.call('HatredResetToHomeSync', { obj_id: enemy })
        assert.equal(playerIsInBattle(f.state()), false)
        f.call('UpgradeOrnament', { u32: f.guid })
        assert.equal(
            f.state().ornaments.find((item) => item.guid === f.guid).lv,
            before.ornaments.find((item) => item.guid === f.guid).lv + 1,
        )
    } finally {
        f.store.close()
    }
})

test('6021 also respects outgoing10806 player relations and the player-node reset', () => {
    const f = fixture('ornament-outgoing-fight')
    try {
        f.call('PlayerHatredIncSync', { inc: true, info: node(String(f.session.id), [enemy]) })
        assert.throws(() => f.call('UpgradeOrnament', { u32: f.guid }), inFight)
        f.call('HatredResetSync', { is_player: true, obj_id: String(f.session.id) })
        f.call('UpgradeOrnament', { u32: f.guid })
    } finally {
        f.store.close()
    }
})

test('unrelated players, casts, existing enemies and stale-map relations do not manufacture a local combat lock', () => {
    const f = fixture('ornament-no-false-fight')
    try {
        f.call('ObjHatredIncSync', { inc: true, info: node(enemy, [], [f.session.id + 1]) })
        assert.equal(playerIsInBattle(f.state()), false)
        const sample = structuredClone(f.state())
        sample.combat.skills = { x: { skill: { skill_id: 1 } } }
        sample.combat.entities = { [enemy]: { hp: 100, alive_state: 0 } }
        assert.equal(playerIsInBattle(sample), false)
        sample.combat.hatred.objects[enemy].player_obj_ids = [f.session.id]
        sample.combat.map_id = sample.world.map_id + 1
        assert.equal(playerIsInBattle(sample), false)
        f.call('UpgradeOrnament', { u32: f.guid })
    } finally {
        f.store.close()
    }
})

test('relation ownership follows the active formation and recorded summon/bullet owners without guessing cycles', () => {
    const f = fixture('ornament-owner-relations')
    try {
        const state = structuredClone(f.state()),
            manager = state.player.group_mgrs.find((entry) => entry.type === 1),
            hero = manager.groups.find((entry) => entry.id === manager.cur_group).control,
            summon = '1224979098644775000',
            bullet = '1152921504606847000'
        state.combat = {
            map_id: state.world.map_id,
            summons: { [summon]: { owner_id: hero } },
            bullets: { [bullet]: { unit_id: summon } },
            hatred: { players: {}, objects: { [enemy]: node(enemy, [bullet]) } },
        }
        assert(playerIsInBattle(state))
        state.combat.summons[summon].owner_id = bullet
        assert.equal(playerIsInBattle(state), false)
    } finally {
        f.store.close()
    }
})

test('actual loaded modern arena field blocks6021, and quitting restores the ordinary upgrade path', () => {
    const f = fixture('ornament-current-arena-fight')
    try {
        f.call('KiboDuelGetGroup', { u32: 501 })
        f.call('MultiCampaignCreate', { dungeon_id: 40007 })
        f.call('MultiCampaignPlayerLoaded')
        f.call('MultiCampaignPlayerLoadFinish')
        assert(playerIsInBattle(f.state()))
        const before = structuredClone(f.state())
        assert.throws(() => f.call('UpgradeOrnament', { u32: f.guid }), inFight)
        assert.deepEqual(f.state(), before)
        f.call('MultiCampaignQuit')
        assert.equal(playerIsInBattle(f.state()), false)
        f.call('UpgradeOrnament', { u32: f.guid })
    } finally {
        f.store.close()
    }
})

test('bad saved relation data and missing prohibition rows are configuration errors rather than silently granting permission', () => {
    const f = fixture('ornament-fight-corruption')
    try {
        const state = structuredClone(f.state())
        state.combat = { map_id: state.world.map_id, hatred: { objects: [] } }
        assert.throws(
            () => playerIsInBattle(state),
            (error) => error.code === ErrorCode.GameConfig,
        )
        state.combat.hatred.objects = { [enemy]: node(enemy, [], [f.session.id]) }
        assert.throws(
            () => requirePlayerOutOfBattle({ state, tables: { find: () => null } }, 1013),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
