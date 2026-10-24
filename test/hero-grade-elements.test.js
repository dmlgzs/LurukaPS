import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { heroData } from '../src/player.js'
import { combatState } from '../src/combat-state.js'
import { refreshHeroGradeElements } from '../src/hero-grade-elements.js'
import { nextHeroGrade } from '../src/hero-grade.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import grades from '../configs/hero-grade-tables/hero_grade.json' with { type: 'json' }
import effects from '../configs/hero-grade-tables/hero_grade_effect.json' with { type: 'json' }

const expected = (id, grade) => {
    const row = grades.find((entry) => entry.heroId === id && entry.grade === grade)
    return [
        ...new Set(
            String(row.mainSkill || '')
                .split('|')
                .filter(Boolean)
                .flatMap((key) =>
                    String(effects.find((entry) => entry.id === Number(key)).gradeSkill || '')
                        .split('|')
                        .filter(Boolean)
                        .map(Number),
                ),
        ),
    ]
}
const edit = (f, fn) => f.store.transact(f.session.id, 0, fn)
function select(f, grade = 1, config = 101003) {
    const id = f.state().player.heros_info.heros.find((hero) => hero.conf_id === config).guid
    edit(f, (state) => {
        state.player.heros_info.heros.find((hero) => hero.guid === id).hero_grade = grade
    })
    return id
}
// Independent current RECEIVE-side contract from0600066c. Request expansion
// subtracts verify timestamps; the client receiver leaves them absolute.
const rows = (f, packets) =>
    packets
        .filter((packet) => packet.id === 10706)
        .flatMap((packet) => {
            const data = f.protocol.decode('BattleInfoReduce', packet.payload),
                dictionary = data.uint64_dic ?? [],
                lookup = (value) => {
                    const index = BigInt(value ?? '0')
                    assert(index >= 0n && index <= BigInt(dictionary.length))
                    return index === 0n ? '0' : dictionary[Number(index) - 1]
                }
            return data.battle_info.map((raw) => {
                const row = structuredClone(raw.element_info)
                assert([2, 10].includes(row.op))
                row.tar_id = lookup(row.tar_id)
                row.uniqueId = lookup(row.uniqueId)
                if (row.parentUniqueId !== undefined) row.parentUniqueId = lookup(row.parentUniqueId)
                for (const field of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
                    if (row.buff[field] !== undefined) row.buff[field] = lookup(row.buff[field])
                if (row.op === 10) row.buff.cfg_id = Number(lookup(row.buff.cfg_id))
                return row
            })
        })
const request = (f, ids) => f.call('RequestHeroElement', { u64s: ids })

test('all23 heroes and161 actual tiers emit exactly their authored element roots as real uint64 local-execution packets', () => {
    const f = achievementFixture('grade-elements-all-data')
    try {
        assert.equal(new Set(grades.map((row) => row.heroId)).size, 23)
        assert.equal(grades.length, 161)
        const visited = new Set()
        for (const row of grades) {
            const hero = { ...heroData(row.heroId, f.session.id), hero_grade: row.grade },
                state = { world: { map_id: 100 }, player: { heros_info: { heros: [hero] } } },
                before = structuredClone(state.player),
                packets = [],
                c = {
                    id: f.session.id,
                    now: 1800000000.123,
                    state,
                    tables: f.tables,
                    push(name, data) {
                        const entry = f.protocol.byName.get(name)
                        packets.push({ id: entry.id, payload: f.protocol.encode(entry.rsp, data) })
                    },
                }
            refreshHeroGradeElements(c, new Set([hero.guid]), combatState(state, c.now))
            const added = rows(f, packets)
            assert.deepEqual(
                added.map((entry) => entry.buff.cfg_id),
                expected(row.heroId, row.grade),
            )
            for (const entry of added) {
                visited.add(entry.buff.cfg_id)
                assert.equal(entry.op, 10)
                assert.equal(entry.tar_id, hero.guid)
                assert.equal(entry.buff.layer, 1)
                assert.equal(entry.buff.begin_time, '1800000000123')
                assert.equal(entry.verify_info.source_type, 6)
                assert.equal(entry.verify_info.source_id, '6')
                assert.equal(entry.verify_info.op_time, '1800000000123')
                assert(BigInt(entry.uniqueId) > BigInt(Number.MAX_SAFE_INTEGER))
                for (const field of ['attacker_id', 'executor_id', 'source_id', 'creator_id'])
                    assert.equal(entry.buff[field], hero.guid)
            }
            assert.deepEqual(state.player, before)
        }
        assert.equal(visited.size, 69)
    } finally {
        f.store.close()
    }
})

test('actual11904 has no ACK, refreshes only owned grade roots, reuses their IDs and clears a removed tier', () => {
    const f = achievementFixture('grade-elements-refresh')
    try {
        const id = select(f),
            first = request(f, [id]),
            initial = rows(f, first)
        assert(!first.some((packet) => packet.id === 11904))
        assert(first.some((packet) => packet.id === 11113))
        assert(initial.length > 0 && initial.every((row) => row.op === 10))
        const sequence = f.state().heroGradeElementSequence,
            again = rows(f, request(f, [id, id]))
        assert.deepEqual(
            again.filter((row) => row.op === 2).map((row) => row.uniqueId),
            initial.map((row) => row.uniqueId),
        )
        assert.deepEqual(
            again.filter((row) => row.op === 10).map((row) => row.uniqueId),
            initial.map((row) => row.uniqueId),
        )
        assert.equal(f.state().heroGradeElementSequence, sequence)
        select(f, 0)
        assert(rows(f, request(f, [id])).every((row) => row.op === 2))
        assert.deepEqual(f.state().combat.hero_grade_elements.heroes[id], [])
        assert.equal(rows(f, request(f, [id])).length, 0)
    } finally {
        f.store.close()
    }
})

test('real6055 cost and data synchronization feed the later initialize request without turning effect keys into skills', () => {
    const f = achievementFixture('grade-elements-upgrade')
    try {
        const id = select(f, 0)
        assert.equal(rows(f, request(f, [id])).length, 0)
        let previous = new Map()
        for (let grade = 1; grade <= 4; grade++) {
            const hero = f.state().player.heros_info.heros.find((entry) => entry.guid === id),
                next = nextHeroGrade(f.tables, hero)
            edit(f, (state) =>
                grantRewards(
                    f.tables,
                    state,
                    [...next.costs].map(([itemid, itemnum]) => ({ itemtype: 3, itemid, itemnum })),
                ),
            )
            const upgraded = f.call('GradeUpHero', { u64: id })
            assert(upgraded.some((packet) => packet.id === 6055))
            const added = rows(f, request(f, [id])).filter((row) => row.op === 10)
            assert.deepEqual(
                added.map((row) => row.buff.cfg_id),
                expected(101003, grade),
            )
            for (const row of added)
                if (previous.has(row.buff.cfg_id)) assert.equal(row.uniqueId, previous.get(row.buff.cfg_id))
            previous = new Map(added.map((row) => [row.buff.cfg_id, row.uniqueId]))
        }
        assert(previous.size >= 2)
        assert.equal(f.state().player.heros_info.heros.find((hero) => hero.guid === id).hero_grade, 4)
    } finally {
        f.store.close()
    }
})

test('refresh preserves unrelated effects and other actors, pruning only observed old self-target grade descendants', () => {
    const f = achievementFixture('grade-elements-isolation')
    try {
        const a = select(f, 1, 101003),
            b = select(f, 1, 101007)
        const aRoot = rows(f, request(f, [a]))[0],
            bRoot = rows(f, request(f, [b]))[0]
        assert(aRoot && bRoot)
        edit(f, (state) => {
            state.combat.elements = {
                [aRoot.uniqueId]: { ...aRoot, updated_at: 1 },
                10001: { op: 1, uniqueId: '10001', parentUniqueId: aRoot.uniqueId, tar_id: a, buff: { cfg_id: 20011 } },
                10002: { op: 1, uniqueId: '10002', parentUniqueId: aRoot.uniqueId, tar_id: b, buff: { cfg_id: 20011 } },
                10003: { op: 1, uniqueId: '10003', tar_id: a, buff: { cfg_id: 20011, begin_time: '5' } },
                10004: {
                    op: 1,
                    uniqueId: '10004',
                    tar_id: a,
                    buff: { cfg_id: aRoot.buff.cfg_id },
                    verify_info: { source_type: 1 },
                },
                10005: {
                    op: 1,
                    uniqueId: '10005',
                    tar_id: a,
                    buff: { cfg_id: aRoot.buff.cfg_id, attacker_id: b, executor_id: a, creator_id: b },
                    verify_info: { source_type: 6, source_id: '6' },
                },
            }
        })
        const previousB = structuredClone(f.state().combat.hero_grade_elements.heroes[b]),
            packets = request(f, [a]),
            state = f.state(),
            legacy = f.protocol.decode('SyncElementInfo', packets.find((packet) => packet.id === 11113).payload)
        assert.equal(state.combat.elements[aRoot.uniqueId], undefined)
        assert.equal(state.combat.elements['10001'], undefined)
        for (const uid of ['10002', '10003', '10004', '10005']) assert(state.combat.elements[uid])
        assert.deepEqual(state.combat.hero_grade_elements.heroes[b], previousB)
        assert.deepEqual(legacy.info.map((row) => row.uniqueId).sort(), ['10003', '10004', '10005'])
        assert.deepEqual(
            rows(f, packets)
                .filter((row) => row.op === 2)
                .map((row) => row.uniqueId)
                .sort(),
            ['10001', aRoot.uniqueId].sort(),
        )
        assert(rows(f, packets).every((row) => row.tar_id === a))
    } finally {
        f.store.close()
    }
})

test('skin recreation, map transfer and current trial selectors derive from the correct hero while leaving permanent progression intact', () => {
    const f = achievementFixture('grade-elements-lifecycle')
    try {
        const id = select(f, 6, 101010),
            first = rows(f, request(f, [id])).filter((row) => row.op === 10)
        assert(first.length > 0)
        f.call('HeroUpdateSkin', { hero_guid: id, skin_id: 1010101 })
        const skinned = rows(f, request(f, [id])).filter((row) => row.op === 10)
        assert.deepEqual(
            skinned.map((row) => row.buff.cfg_id),
            expected(101010, 6),
        )
        assert.deepEqual(
            skinned.map((row) => row.uniqueId),
            first.map((row) => row.uniqueId),
        )
        const sequence = f.state().heroGradeElementSequence
        f.call('WorldPoint', { point_id: 10045 })
        const transferred = rows(f, request(f, [id])).filter((row) => row.op === 10)
        assert(transferred.every((row) => !first.some((old) => old.uniqueId === row.uniqueId)))
        assert(f.state().heroGradeElementSequence > sequence)
        const trial = {
            ...heroData(101003, f.session.id),
            guid: ((5n << 56n) | (101003n << 32n) | BigInt(f.session.id)).toString(),
            trail: true,
            hero_grade: 4,
        }
        edit(f, (state) => {
            state.trialGroup = { heroes: [trial], pets: [] }
        })
        const permanent = structuredClone(f.state().player.heros_info.heros),
            added = rows(f, request(f, [trial.guid])).filter((row) => row.op === 10)
        assert.deepEqual(
            added.map((row) => row.buff.cfg_id),
            expected(101003, 4),
        )
        assert(added.every((row) => row.tar_id === trial.guid))
        assert.deepEqual(f.state().player.heros_info.heros, permanent)
    } finally {
        f.store.close()
    }
})

test('foreign selectors, broken saved bindings and actual10706 encoding faults roll back the root sequence and all changes', () => {
    const f = achievementFixture('grade-elements-rollback')
    try {
        const id = select(f),
            before = structuredClone(f.state()),
            foreign = ((1n << 56n) | (101003n << 32n) | BigInt(f.session.id + 1)).toString()
        assert.throws(() => request(f, [id, foreign]))
        assert.deepEqual(f.state(), before)
        const original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'SCProtoBattleInfoReduceNtf') throw Error('grade element10706 fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => request(f, [id]), /grade element10706 fault/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        request(f, [id])
        edit(f, (state) => {
            state.combat.hero_grade_elements.heroes[id][0].uid = '2'
        })
        const broken = structuredClone(f.state())
        assert.throws(
            () => request(f, [id]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), broken)
    } finally {
        f.store.close()
    }
})

test('persistent sequence and bindings survive real SQLite login and refresh without allocating a duplicate set', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-grade-elements-')),
        file = path.join(directory, 'grade.sqlite')
    let f
    try {
        f = achievementFixture('grade-elements-persist', file)
        const id = select(f, 4),
            first = rows(f, request(f, [id])).filter((row) => row.op === 10),
            sequence = f.state().heroGradeElementSequence
        f.store.close()
        f = null
        f = achievementFixture('grade-elements-persist', file)
        const second = rows(f, request(f, [id])).filter((row) => row.op === 10)
        assert.deepEqual(
            second.map((row) => row.uniqueId),
            first.map((row) => row.uniqueId),
        )
        assert.equal(f.state().heroGradeElementSequence, sequence)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('luruka-grade-elements-'))
        for (const suffix of ['', '-wal', '-shm', '-journal'])
            if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
        fs.rmdirSync(directory)
    }
})

test('identity capacity failure and cross-actor saved UID collisions cannot partially replace another root set', () => {
    const f = achievementFixture('grade-elements-identity-integrity')
    try {
        const a = select(f, 4, 101003)
        edit(f, (state) => {
            state.heroGradeElementSequence = 0x1fffffe
        })
        const exhausted = structuredClone(f.state())
        // The first allocation can succeed but the second must fail. The
        // transaction must also undo that first reservation.
        assert.throws(
            () => request(f, [a]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), exhausted)
        edit(f, (state) => {
            state.heroGradeElementSequence = 0
        })
        select(f, 1, 101003)
        const b = select(f, 1, 101007)
        request(f, [a, b])
        edit(f, (state) => {
            state.combat.hero_grade_elements.heroes[b][0].uid = state.combat.hero_grade_elements.heroes[a][0].uid
        })
        const duplicate = structuredClone(f.state())
        assert.throws(
            () => request(f, [a]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), duplicate)
    } finally {
        f.store.close()
    }
})

test('a removed old configuration never blocks clearing its already-owned UID', () => {
    const f = achievementFixture('grade-elements-retired-config')
    try {
        const id = select(f),
            first = rows(f, request(f, [id]))[0]
        edit(f, (state) => {
            state.player.heros_info.heros.find((hero) => hero.guid === id).hero_grade = 0
            state.combat.hero_grade_elements.heroes[id][0].config_id = 0x7fffffff
        })
        const cleared = rows(f, request(f, [id]))
        assert.deepEqual(
            cleared.map((row) => [row.op, row.uniqueId]),
            [[2, first.uniqueId]],
        )
        assert.deepEqual(f.state().combat.hero_grade_elements.heroes[id], [])
    } finally {
        f.store.close()
    }
})

test('the existing nonhero11904 replay contract does not acquire hero roots or allocate identities', () => {
    const f = achievementFixture('grade-elements-nonhero-compatibility')
    try {
        const pet = f.state().pets[0]
        edit(f, (state) => {
            combatState(state, 1800000000).elements['123456'] = {
                op: 1,
                uniqueId: '123456',
                tar_id: pet.guid,
                buff: { cfg_id: 20011, layer: 1 },
                updated_at: 1,
            }
        })
        const packets = request(f, [pet.guid])
        assert.equal(rows(f, packets).length, 0)
        assert.equal(f.state().heroGradeElementSequence, undefined)
        const legacy = f.protocol.decode('SyncElementInfo', packets.find((packet) => packet.id === 11113).payload)
        assert.deepEqual(
            legacy.info.map((row) => row.uniqueId),
            ['123456'],
        )
        assert.equal(f.state().combat.hero_grade_elements, undefined)
    } finally {
        f.store.close()
    }
})

test('unresolved resource metadata is an unsupported capability and never deletes an already-published root', () => {
    const f = achievementFixture('grade-elements-unknown-resource'),
        effect = effects.find((row) => row.id === 10100301),
        original = effect.gradeSkill
    try {
        const id = select(f)
        request(f, [id])
        const before = structuredClone(f.state())
        effect.gradeSkill = '4294967295'
        assert.throws(
            () => request(f, [id]),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        effect.gradeSkill = original
        f.store.close()
    }
})

test('an invalid observed child UID cannot become a wildcard clear or partially replace a grade root', () => {
    const f = achievementFixture('grade-elements-child-integrity')
    try {
        const id = select(f),
            root = rows(f, request(f, [id]))[0]
        edit(f, (state) => {
            state.combat.elements['0'] = {
                op: 1,
                uniqueId: '0',
                parentUniqueId: root.uniqueId,
                tar_id: id,
                buff: { cfg_id: 20011 },
            }
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => request(f, [id]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('entity initialize bursts share the existing deferred store, immediately retain distinct UIDs and flush with one normal request', () => {
    const f = achievementFixture('grade-elements-deferred-initialize')
    try {
        const a = select(f, 1, 101003),
            b = select(f, 1, 101007),
            changes = () => f.store.db.prepare('SELECT total_changes() AS n').get().n,
            before = changes(),
            aRows = rows(f, request(f, [a])).filter((row) => row.op === 10),
            bRows = rows(f, request(f, [b])).filter((row) => row.op === 10)
        request(f, [a])
        assert.equal(changes(), before)
        assert(aRows.length && bRows.length)
        assert(aRows.every((aRow) => !bRows.some((bRow) => aRow.uniqueId === bRow.uniqueId)))
        const state = structuredClone(f.state())
        assert.equal(state.heroGradeElementSequence, aRows.length + bRows.length)
        f.call('ActivityGet')
        assert(changes() > before)
        assert.equal(f.state().heroGradeElementSequence, state.heroGradeElementSequence)
        assert.deepEqual(f.state().combat.hero_grade_elements, state.combat.hero_grade_elements)
    } finally {
        f.store.close()
    }
})
