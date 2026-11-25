import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables, seedPlayer } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { ErrorCode } from '../src/error-codes.js'
import { defaultHomeBuildings } from '../src/home-default-placement.js'
import { ensureHome, homePayload } from '../src/home.js'
import { homeExchangeLoginData } from '../src/home-exchange.js'
import { dormTopics } from '../src/home-dorm.js'
import { simpleProductSnapshot } from '../src/simple-production.js'

const tables = new Tables(configuration().tables)
function constant(type, value, missing) {
    return {
        get(name) {
            if (name !== 'game') return tables.get(name)
            return [{ title: 'HOME_DEFAULT_PLACEMENT', type, value }]
        },
        find(name, id) {
            return missing?.(name, id) ? undefined : tables.find(name, id)
        },
    }
}
function state() {
    return { player: { basic_info: { lv: 1, home_lv: 1 }, attr_infos: { attrs: [] } }, pets: [] }
}

test('actual 1.0 default home creates all configured placements and empty collection messages without rewards', () => {
    const saved = state(),
        before = structuredClone(saved),
        home = ensureHome(tables, saved)
    assert.deepEqual(
        home.builds.map((build) => [
            build.build_id,
            build.locate.block_id,
            build.locate.anchor,
            build.locate.direction,
        ]),
        [
            [10000, 101, 8323089, 0],
            [130031, 101, 7536677, 0],
            [130011, 101, 8323109, 0],
        ],
    )
    assert.deepEqual(
        home.builds.map((build) => build.guid),
        [1, 2, 3],
    )
    assert.deepEqual(
        home.builds.map((build) => build.build_type),
        [2, 24, 24],
    )
    assert(home.builds.every((build) => build.build_level === 1 && build.status === 1))
    assert.equal(home.nextBuildGuid, 4)
    assert.equal(home.inventory.length, 3)
    assert(home.inventory.every((entry) => entry.total_num === 1 && entry.used_num === 1 && entry.unlock))
    for (const build of home.builds.filter((entry) => entry.build_type === 24))
        assert.deepEqual(build.collect_build_data, {
            guid: build.guid,
            build_id: build.build_id,
            start_time: 0,
            pet_guid: '0',
            product_infos: [],
            items: [],
        })
    assert.equal(home.exp, 0)
    assert.equal(home.experienceTotal, '0')
    assert.deepEqual(saved.player.attr_infos, before.player.attr_infos)
    assert.equal(saved.claims, undefined)
})

test('declared CBT3 flat list stays supported without a fallback source', () => {
    const defaults = defaultHomeBuildings(constant('list<int>', '13|10000|101|8323091|0'))
    assert.equal(defaults.builds.length, 1)
    assert.equal(defaults.builds[0].locate.anchor, 8323091)
    assert.equal(defaults.nextBuildGuid, 2)
})

test('repeated configured building IDs create separate instances and aggregate owned inventory', () => {
    const defaults = defaultHomeBuildings(constant('list<list<int>>', '13#10000#101#8323089#0|13#10000#101#7536677#1'))
    assert.deepEqual(defaults.inventory, [{ build_id: 10000, total_num: 2, used_num: 2, unlock: true }])
    assert.deepEqual(
        defaults.builds.map((build) => build.guid),
        [1, 2],
    )
    assert.equal(defaults.builds[1].locate.direction, 1)
})

test('invalid or missing configured placements fail before installing a partial home', () => {
    for (const [type, value] of [
        ['list<int>', '13#10000#101#8323089#0'],
        ['list<list<int>>', '13#10000#101#8323089#0|'],
        ['list<list<int>>', '13#10000#101##0'],
        ['list<list<int>>', '13#10000#101#4294967296#0'],
        ['list<list<int>>', '13#10000#101#8323089#4'],
        ['list<list<int>>', '12#10000#101#8323089#0'],
        ['string', '13#10000#101#8323089#0'],
    ]) {
        const saved = state()
        assert.throws(() => ensureHome(constant(type, value), saved), { code: ErrorCode.GameConfig })
        assert.equal(saved.home, undefined)
    }
    for (const [missingName, code] of [
        ['home_building', ErrorCode.BuildConfNotFound],
        ['home_block', ErrorCode.GameConfig],
    ]) {
        const saved = state()
        assert.throws(
            () =>
                ensureHome(
                    constant('list<int>', '13|10000|101|8323091|0', (name) => name === missingName),
                    saved,
                ),
            { code },
        )
        assert.equal(saved.home, undefined)
    }
})

test('an existing home is not rebuilt or topped up from changed default placements', () => {
    const saved = state(),
        home = ensureHome(tables, saved)
    home.name = 'saved-home'
    home.builds.splice(1)
    home.inventory.splice(1)
    const before = structuredClone(saved.home)
    assert.equal(ensureHome(constant('invalid', ''), saved), home)
    assert.deepEqual(saved.home, before)
})

test('fresh real-table home login projections encode with all active 1.0 protobuf field checks', () => {
    const protocol = new Protocol(configuration().base),
        saved = seedPlayer(tables, 1, 'home-projection-test'),
        now = 1795651200
    ensureHome(tables, saved)
    const packets = [
        ['CSProtoHomeSync', homePayload(tables, saved)],
        ...homeExchangeLoginData(tables, saved, now),
        ['SCProtoHomeHeroStoryInfoNtf', dormTopics(tables, saved, now)],
        ['CSProtoSimpleProductFinish', simpleProductSnapshot(saved)],
    ]
    for (const [name, value] of packets) {
        const entry = protocol.byName.get(name)
        assert(entry?.rsp, name)
        const encoded = protocol.encode(entry.rsp, value),
            decoded = protocol.decode(entry.rsp, encoded)
        if (name !== 'CSProtoHomeSync') continue
        for (const build of saved.home.builds) {
            const wire = decoded.home_builds.find((entry) => entry.guid === build.guid)
            assert.equal(wire.build_id, build.build_id)
            assert.equal(wire.build_level, build.build_level)
            assert.deepEqual(wire.locate, build.locate)
            if (build.build_type === 24) {
                assert.equal(wire.collect_build_data.build_id, build.build_id)
                assert.deepEqual(wire.collect_build_data.product_infos, [])
                assert.deepEqual(wire.collect_build_data.items, [])
            }
        }
    }
    assert.deepEqual(saved.claims, [])
    assert.equal(saved.home.exp, 0)
})
