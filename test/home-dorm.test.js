import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { homePayload } from '../src/home.js'
import { gridAnchor } from '../src/home-grid.js'
import { ensureHomeDormitories, dormTopics, addHeroFavorability, homeMapId } from '../src/home-dorm.js'

const config = configuration(),
    tables = new Tables(config.tables),
    p = new Protocol(config.base)
function setup() {
    const store = new Store(':memory:'),
        session = {}
    let now = Date.UTC(2026, 9, 11, 4) / 1000,
        seq = 1
    const game = new Game(p, store, tables, { clock: () => now })
    const call = (name, request = {}, target = session) => {
        const entry = p.byName.get('CSProto' + name)
        return game.dispatch(target, { id: entry.id, seq: seq++, pushSeq: 0, payload: p.encode(entry.req, request) })
    }
    call('EnterGame', { open_id: 'dorm-tests' })
    store.transact(session.id, 0, (state) => {
        // Legacy account's placed builds have no dorm field at all.
        state.home.builds.push(
            ...[22, 23].map((guid) => ({
                guid,
                build_id: 50011,
                build_type: 5,
                status: 1,
                locate: { block_id: 101, anchor: guid === 22 ? 7405623 : 6488119, direction: 0 },
            })),
        )
        state.home.inventory.push({ build_id: 50011, total_num: 2, used_num: 2, unlock: true })
    })
    const state = () => store.load(session.id).state
    const actor = (id) => state().player.heros_info.heros.find((hero) => hero.conf_id === id)
    const enroll = (id, index = 1, build = 22, out = '0') =>
        call('HomeDormCheckIn', { build_guid: build, dorm_index: index, hero_in: actor(id).guid, hero_out: out })
    return {
        store,
        session,
        game,
        call,
        state,
        actor,
        enroll,
        advance: (seconds) => {
            now += seconds
        },
    }
}
const decode = (packets, name) => {
    const e = p.byName.get(name)
    return p.decode(e.rsp, packets.find((packet) => packet.id === e.id).payload)
}
test('CBT3 dorm slots migrate, publish both resident representations, move atomically and persist through login', () => {
    const f = setup()
    try {
        const original = structuredClone(f.state().player.group_mgrs)
        const reply = f.enroll(101010)
        const payload = decode(reply, 'CSProtoHomeSync')
        const slot = payload.home_builds.find((entry) => entry.guid === 22).dorm
        assert.deepEqual(slot.dorm_heros, [{ hero_id: f.actor(101010).guid, dorm_index: 1 }])
        assert.deepEqual(slot.hero_ids, [f.actor(101010).guid])
        assert.equal(f.actor(101010).dorm_id, 22)
        f.enroll(107002, 3) // current CBT3 table is 3; old group table said 1.
        const before = f.state()
        assert.throws(() => f.enroll(101008, 4), /slot/)
        assert.throws(() => f.enroll(101008, 1), /resident changed/)
        assert.deepEqual(f.state(), before)
        f.enroll(101010, 2, 23)
        assert.equal(f.state().home.builds.find((b) => b.guid === 22).dorm.dorm_heros.length, 1)
        assert.equal(f.actor(101010).dorm_id, 23)
        f.call('HomeDormChangeName', { build_guid: 23, name: '小玉的家' })
        const login = f.call('EnterGame', { open_id: 'dorm-tests' }, {})
        assert.equal(decode(login, 'CSProtoHomeSync').home_builds.find((b) => b.guid === 23).dorm.name, '小玉的家')
        assert.deepEqual(f.state().player.group_mgrs, original)
        f.call('HomeDormCheckIn', { build_guid: 23, dorm_index: 2, hero_in: '0', hero_out: f.actor(101010).guid })
        assert.equal(f.actor(101010).dorm_id, 0)
    } finally {
        f.store.close()
    }
})
test('dorm visit binds role before world entry, returns to saved home position and restores on reconnect', () => {
    const f = setup()
    try {
        f.enroll(101010)
        f.enroll(107002, 2)
        f.call('EnterHome')
        const origin = f.state().world.pos,
            history = f.state().worldHistory
        const packets = f.call('HomeDormEnter', { build_guid: 22, hero_id: f.actor(101010).guid })
        assert(
            packets.findIndex((x) => x.id === 6217) <
                packets.findIndex((x) => x.id === p.byName.get('CSProtoWorldMapSync').id),
        )
        assert.equal(decode(packets, 'SCProtoHomeDormReEnterNtf').hero_id, f.actor(101010).guid)
        assert.equal(f.state().world.map_id, 30010)
        assert.deepEqual(f.state().worldHistory, history)
        const login = f.call('EnterGame', { open_id: 'dorm-tests', reconnect: true }, {})
        assert.equal(decode(login, 'SCProtoHomeDormReEnterNtf').hero_id, f.actor(101010).guid)
        f.call('HomeDormEnter', { build_guid: 22, hero_id: f.actor(107002).guid, is_change: true })
        assert.equal(f.state().world.map_id, tables.get('home_dorm_scene').find((row) => row.heroId === 107002).sceneId)
        f.call('HomeDormQuit')
        assert.equal(f.state().world.map_id, homeMapId(tables))
        assert.deepEqual(f.state().world.pos, origin)
        assert.equal(f.state().home.dormVisit, undefined)
        f.call('HomeDormQuit')
    } finally {
        f.store.close()
    }
})
test('exclusive styles are immediately available, duplicate grants remain unique, and night scenes and pajamas work', () => {
    const f = setup()
    try {
        f.enroll(101010)
        f.call('ChangeHeroBackGround', { build_guid: 22, hero_id: f.actor(101010).guid, itemid: 10101001 })
        f.store.transact(f.session.id, 0, (s) => {
            grantRewards(tables, s, [{ itemtype: 40, itemid: 10101001, itemnum: 1 }])
            grantRewards(tables, s, [{ itemtype: 40, itemid: 10101001, itemnum: 1 }])
        })
        assert.equal(
            f.state().home.dorm.back_ground_scene.rewards.filter((entry) => entry.itemid === 10101001).length,
            1,
        )
        const style = { build_guid: 22, hero_id: f.actor(101010).guid, itemid: 10101001 }
        f.call('ChangeHeroBackGround', style)
        f.call('HomeHeroDressUp', { hero_id: f.actor(101010).guid, item_id: 10101001 })
        assert.throws(
            () => f.call('HomeHeroDressUp', { hero_id: f.actor(107002).guid, item_id: 10101001 }),
            /another hero/,
        )
        f.call('EnterHome')
        f.call('WorldTimeSync', { world_time: 21 }) // 20:00 = night; wire hour + 1.
        f.call('HomeDormEnter', { build_guid: 22, hero_id: f.actor(101010).guid })
        assert.equal(f.state().world.map_id, 32011)
        f.call('ChangeHeroBackGround', { ...style, itemid: 0, is_change: true })
        assert.equal(f.state().world.map_id, 30011)
        const sync = decode(f.call('HomeHeroDressUp', { hero_id: f.actor(101010).guid, item_id: 0 }), 'CSProtoHomeSync')
        assert.equal(sync.dorm.hero_pajamas.find((x) => x.hero_id === f.actor(101010).guid).pajamas_itemid, 0)
        f.call('HomeDormQuit')
    } finally {
        f.store.close()
    }
})
test('daily topic is offered from table, credits actual favorability once and resets at daily boundary', () => {
    const f = setup()
    try {
        f.enroll(101010)
        f.call('EnterHome')
        const packets = f.call('HomeDormEnter', { build_guid: 22, hero_id: f.actor(101010).guid })
        const story = decode(packets, 'SCProtoHomeHeroStoryInfoNtf').storys.find((row) => row.heor_id === 101010)
        const expected = Number(
            tables
                .get('home_dorm_scene')
                .find((row) => row.heroId === 101010)
                .dailyStory.split('|')
                .find((x) => x.startsWith(story.story_id + '#'))
                .split('#')[1],
        )
        const result = decode(f.call('HomeHeroStoryReward', { storys: story }), 'CSProtoHomeHeroStoryReward')
        assert.equal(result.favorability, expected)
        assert.equal(f.actor(101010).favorability_exp, expected)
        assert.equal(
            decode(f.call('HomeHeroStoryReward', { storys: story }), 'CSProtoHomeHeroStoryReward').favorability,
            0,
        )
        const before = f.state()
        assert.throws(
            () => f.call('HomeHeroStoryReward', { storys: { heor_id: 107002, story_id: story.story_id } }),
            /another hero/,
        )
        assert.deepEqual(f.state(), before)
        f.advance(86400)
        const refresh = f.game.tick(f.session.id)
        assert(decode(refresh, 'SCProtoHomeHeroStoryInfoNtf').storys.some((row) => row.heor_id === 101010))
        assert.equal(f.state().home.dormTopics.heroes[101010].complete, false)
        assert.deepEqual(f.game.tick(f.session.id), [])
    } finally {
        f.store.close()
    }
})
test('gifts spend inventory, obey configured limits, furniture persists and level rewards claim only once', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 110001, itemnum: 30 },
                { itemtype: 3, itemid: 111001, itemnum: 2 },
            ]),
        )
        f.call('SendHeroGift', { heroId: 107002, item_id: 111001, item_type: 111, num: 1 })
        assert.deepEqual(f.actor(107002).furnitures, [111001])
        const before = f.state()
        assert.throws(
            () => f.call('SendHeroGift', { heroId: 107002, item_id: 111001, item_type: 111, num: 1 }),
            /already/,
        )
        assert.throws(
            () => f.call('SendHeroGift', { heroId: 101010, item_id: 111001, item_type: 111, num: 1 }),
            /another hero/,
        )
        assert.deepEqual(f.state(), before)
        f.call('SendHeroGift', { heroId: 101010, item_id: 110001, item_type: 110, num: 10 })
        assert.equal(f.actor(101010).favorability_exp, 800)
        assert.equal(f.actor(101010).daily_gift_num, 10)
        assert.throws(
            () => f.call('SendHeroGift', { heroId: 101010, item_id: 110001, item_type: 110, num: 1 }),
            /limit/,
        )
        f.store.transact(f.session.id, 0, (s) =>
            addHeroFavorability(
                tables,
                s.player.heros_info.heros.find((h) => h.conf_id === 101010),
                2000,
            ),
        )
        assert.equal(f.actor(101010).favorability_lv, 2)
        const reward = decode(f.call('GotFavorReward', { u64: f.actor(101010).guid }), 'CSProtoGotFavorReward')
        assert(reward.rewards.length > 0)
        assert.deepEqual(
            decode(f.call('GotFavorReward', { u64: f.actor(101010).guid }), 'CSProtoGotFavorReward').rewards,
            [],
        )
        f.advance(86400)
        f.call('SendHeroGift', { heroId: 101010, item_id: 110001, item_type: 110, num: 1 })
        assert.equal(f.actor(101010).daily_gift_num, 1)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
        assert(Array.isArray(decode(f.call('HomeFurnitureRecommend'), 'CSProtoHomeFurnitureRecommend').id))
    } finally {
        f.store.close()
    }
})
test('storing a dorm vacates residents; stale visits are cleared when transferring elsewhere', () => {
    const f = setup()
    try {
        f.enroll(101010)
        f.call('BuildUnlocate', { guid: 22 })
        assert.equal(f.actor(101010).dorm_id, 0)
        assert.deepEqual(f.state().home.storedBuilds.find((b) => b.guid === 22).dorm.dorm_heros, [])
        assert.throws(() => f.call('HomeDormEnter', { build_guid: 22, hero_id: f.actor(101010).guid }), /placed/)
        f.enroll(101010, 1, 23)
        f.call('EnterHome')
        f.call('HomeDormEnter', { build_guid: 23, hero_id: f.actor(101010).guid })
        assert.throws(() => f.call('BuildUnlocate', { guid: 23 }), /being visited/)
        f.call('EnterWorldMap', { point_id: 10045 })
        assert.equal(f.state().home.dormVisit, undefined)
        f.call('HomeDormQuit')
        assert.equal(f.state().world.map_id, 100)
    } finally {
        f.store.close()
    }
})
test('all configured heroes and exclusive styles serialize matching day/night scenes without hardcoded IDs', () => {
    const f = setup()
    try {
        const rows = tables.get('home_dorm_scene').filter((row) => row.canEnterDorm === 1)
        const payload = homePayload(tables, f.state())
        assert.equal(payload.dorm.hero_back_ground.length, rows.length)
        for (const row of rows) {
            const background = payload.dorm.hero_back_ground.find((entry) => entry.hero_id === f.actor(row.heroId).guid)
            assert.equal(background.sceneid, row.sceneId)
            assert.equal(background.night_sceneid, row.sceneIdNight)
        }
        for (const style of tables.get('home_dorm_item')) {
            f.enroll(
                style.heroId,
                1,
                22,
                f.state().home.builds.find((b) => b.guid === 22).dorm?.dorm_heros[0]?.hero_id ?? '0',
            )
            f.store.transact(f.session.id, 0, (s) =>
                grantRewards(tables, s, [{ itemtype: 40, itemid: style.id, itemnum: 1 }]),
            )
            const sync = decode(
                f.call('ChangeHeroBackGround', {
                    build_guid: 22,
                    hero_id: f.actor(style.heroId).guid,
                    itemid: style.id,
                }),
                'CSProtoHomeSync',
            )
            const row = rows.find((row) => row.heroId === style.heroId)
            const index = row.unlockItem.split('|').map(Number).indexOf(style.id)
            const background = sync.dorm.hero_back_ground.find((entry) => entry.hero_id === f.actor(style.heroId).guid)
            assert.equal(background.sceneid, Number(row.exclusivedormScene.split('|')[index]))
            assert.equal(background.night_sceneid, Number(row.exclusivedormSceneNight.split('|')[index]))
        }
    } finally {
        f.store.close()
    }
})
test('newly placed CBT3 dorm includes its empty room before the placement acknowledgement', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 35 // home_building_num group5002 unlockCondition.
            grantRewards(tables, s, [{ itemtype: 13, itemid: 50021, itemnum: 1 }])
        })
        const packets = f.call('BuildLocate', {
            build_id: 50021,
            locate: { block_id: 101, anchor: gridAnchor(-50, -15), direction: 0 },
        })
        const build = decode(packets, 'CSProtoBuildLocate')
        assert.equal(build.build_type, 5)
        assert.deepEqual(build.dorm.dorm_heros, [])
        assert.equal(build.dorm.block_id, 101)
        f.enroll(199003, 3, build.guid)
        const before = f.state()
        assert.throws(() => f.call('HomeDormChangeName', { build_guid: build.guid, name: '' }), /name/)
        assert.throws(
            () =>
                f.call('HomeDormCheckIn', { build_guid: build.guid, dorm_index: 1, hero_in: '999999', hero_out: '0' }),
            /not owned/,
        )
        assert.deepEqual(f.state(), before)
        ensureHomeDormitories(tables, f.state())
    } finally {
        f.store.close()
    }
})
test('relogin migrates missing exclusive ownership, preserves selected styles and pajamas, and is idempotent', () => {
    const f = setup()
    try {
        f.enroll(101010)
        f.call('ChangeHeroBackGround', { build_guid: 22, hero_id: f.actor(101010).guid, itemid: 10101001 })
        f.call('HomeHeroDressUp', { hero_id: f.actor(101010).guid, item_id: 10101001 })
        const selected = f.state().home.dorm.hero_back_ground,
            pajamas = f.state().home.dorm.hero_pajamas
        f.store.transact(f.session.id, 0, (s) => {
            s.home.dorm.back_ground_scene.rewards = []
        })
        const login = f.call('EnterGame', { open_id: 'dorm-tests' }, {})
        const data = decode(login, 'CSProtoHomeSync').dorm
        assert.deepEqual(
            data.back_ground_scene.rewards.map((entry) => entry.itemid).sort(),
            tables
                .get('home_dorm_item')
                .map((entry) => entry.id)
                .sort(),
        )
        assert.deepEqual(f.state().home.dorm.hero_back_ground, selected)
        assert.deepEqual(f.state().home.dorm.hero_pajamas, pajamas)
        const copy = f.state(),
            revision = copy.homeRevision
        assert.equal(ensureHomeDormitories(tables, copy), false)
        assert.equal(copy.homeRevision, revision)
        assert.throws(
            () => f.call('HomeHeroDressUp', { hero_id: f.actor(101010).guid, item_id: 10700201 }),
            /another hero/,
        )
        assert.throws(
            () => f.call('ChangeHeroBackGround', { build_guid: 22, hero_id: f.actor(101010).guid, itemid: 123456789 }),
            /another hero/,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros = s.player.heros_info.heros.filter((actor) => actor.conf_id !== 101008)
            s.home.dorm.back_ground_scene.rewards = s.home.dorm.back_ground_scene.rewards.filter(
                (entry) => entry.itemid !== 10100801,
            )
            ensureHomeDormitories(tables, s)
            assert(!s.home.dorm.back_ground_scene.rewards.some((entry) => entry.itemid === 10100801))
            const before = s.homeRevision
            grantRewards(tables, s, [{ itemtype: 1, itemid: 101008, itemnum: 1 }])
            assert(s.homeRevision > before)
            assert(
                s.home.dorm.back_ground_scene.rewards.some((entry) => entry.itemid === 10100801 && entry.itemnum === 1),
            )
        })
    } finally {
        f.store.close()
    }
})
