import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { petSoulRow, petSoulAttributes, planPetSoulUpgrade } from '../src/pet-star-soul.js'
import { petData } from '../src/pets.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const packed = (group, node) => ((BigInt(group) << 32n) | BigInt(node)).toString()
const amount = (state, type, id) =>
    type === 10 && id === 2
        ? state.player.basic_info.gold
        : state.player.sbag_infos.items
              .filter((item) => item.itemid === id)
              .reduce((total, item) => total + item.itemnum, 0)
function fixture(name) {
    const account = 'pet-star-soul-current-' + name,
        f = achievementFixture(account)
    const guid = f.state().pets.find((pet) => pet.config_id === 500001)?.guid
    assert(guid)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    edit((state) => {
        state.tasks = []
        state.taskRecords = f.tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: 1799999900 }))
        const pet = state.pets.find((pet) => pet.guid === guid)
        pet.lv = 1
        pet.suppress_lv = 0
        const config = f.tables.find('pet', pet.config_id),
            costs = new Map()
        for (const row of f.tables
            .get('pet_starsoul')
            .filter((row) => row.templateId === config.starsoulId && row.type !== 3)) {
            for (const reward of [
                ...parseRewards(row.item),
                ...(row.kiboItemNum ? [{ itemtype: 3, itemid: config.starsoulItem, itemnum: row.kiboItemNum }] : []),
            ]) {
                const key = reward.itemtype + ':' + reward.itemid
                costs.set(key, { ...reward, itemnum: (costs.get(key)?.itemnum ?? 0) + reward.itemnum })
            }
        }
        grantRewards(f.tables, state, [...costs.values()])
    })
    const pet = () => f.state().pets.find((pet) => pet.guid === guid)
    const login = () => {
        const entry = f.protocol.byName.get('CSProtoEnterGame')
        return f.game.dispatch(
            {},
            { id: entry.id, seq: 1, payload: f.protocol.encode(entry.req, { open_id: account, reconnect: true }) },
        )
    }
    return {
        ...f,
        guid,
        edit,
        pet,
        login,
        snapshot: () => f.store.load(f.session.id),
        up: () => f.call('KiboStarLinkSoulUpdate', { u64: guid }),
    }
}
function publishedPet(f, packets) {
    const index = packets.findIndex((packet) => packet.id === 6517),
        ack = packets.findIndex((packet) => packet.id === 11912)
    assert(index >= 0 && index < ack, 'petAction refreshStarSoul success callback reads the already synchronized pet')
    assert(
        packets.some((packet, i) => packet.id === 10006 && i < ack),
        'Derived combat attributes precede the UI callback',
    )
    return f.protocol
        .decode(f.protocol.byId.get(6517).rsp, packets[index].payload)
        .pet_infos.pets.find((pet) => pet.guid === f.guid)
}

test('current11912 uses the displayed node pet-level gate, including0, and publishes packed star-soul before its success callback', () => {
    const f = fixture('opening')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 1
        })
        for (const next of [
            [1, 2],
            [2, 1],
        ]) {
            const before = f.state(),
                row = petSoulRow(f.tables, f.pet()).row
            assert.equal(row.unlocklevel, 0)
            const costs = parseRewards(row.item),
                packets = f.up(),
                wire = publishedPet(f, packets)
            assert.equal(wire.soul_link_level, packed(...next))
            // Same unpacking as current petAction.lua: floor(high32), low32.
            assert.deepEqual(
                [Number(BigInt(wire.soul_link_level) >> 32n), Number(BigInt(wire.soul_link_level) & 0xffffffffn)],
                next,
            )
            for (const cost of costs)
                assert.equal(
                    amount(before, cost.itemtype, cost.itemid) - amount(f.state(), cost.itemtype, cost.itemid),
                    cost.itemnum,
                )
        }
        assert.equal(f.pet().lv, 1)
        assert.equal(petSoulRow(f.tables, f.pet()).row.unlocklevel, 50)
        const saved = f.snapshot()
        assert.throws(f.up, (error) => error.code === ErrorCode.PetSoulLevelCondition)
        assert.deepEqual(f.snapshot(), saved)
        const login = f.login(),
            synced = f.protocol.decode(
                f.protocol.byId.get(6517).rsp,
                login.find((packet) => packet.id === 6517).payload,
            )
        assert.equal(synced.pet_infos.pets.find((pet) => pet.guid === f.guid).soul_link_level, packed(2, 1))
    } finally {
        f.store.close()
    }
})

test('all current templates use pet-level thresholds while player LV cannot bypass them, and saved unlocked nodes are never downgraded', () => {
    const f = fixture('boundaries')
    try {
        const state = f.state(),
            rows = f.tables.get('pet_starsoul')
        assert.equal(rows.length, 126)
        assert(rows.every((row) => !Object.hasOwn(row, 'unlockCondition')))
        assert.deepEqual(
            [...new Set(rows.map((row) => row.unlocklevel))].sort((a, b) => a - b),
            [0, 50, 60, 70, 80],
        )
        for (const template of new Set(rows.map((row) => row.templateId))) {
            const config = f.tables.get('pet').find((row) => row.starsoulId === template)
            assert(config)
            const pet = petData(f.tables, config.id, f.guid, 2001)
            pet.suppress_lv = 0
            for (const row of rows.filter((row) => row.templateId === template && row.type !== 3)) {
                pet.soul_link_level = packed(row.group, row.node)
                pet.lv = Math.max(1, row.unlocklevel)
                state.player.basic_info.lv = 1
                assert(planPetSoulUpgrade(f.tables, state, pet).value)
                if (row.unlocklevel > 0) {
                    pet.lv = row.unlocklevel - 1
                    state.player.basic_info.lv = 99
                    const oldLevel = pet.soul_link_level,
                        oldAttrs = petSoulAttributes(f.tables, pet)
                    assert.throws(
                        () => planPetSoulUpgrade(f.tables, state, pet),
                        (error) => error.code === ErrorCode.PetSoulLevelCondition,
                    )
                    assert.equal(pet.soul_link_level, oldLevel)
                    assert.deepEqual(petSoulAttributes(f.tables, pet), oldAttrs)
                }
            }
        }
    } finally {
        f.store.close()
    }
})

test('real high-level upgrades retain current costs, cumulative progress and terminal rejection across11912 and reconnect', () => {
    const f = fixture('full')
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 1
            state.pets.find((pet) => pet.guid === f.guid).lv = 80
        })
        const rows = petSoulRow(f.tables, f.pet()).rows
        for (let index = 0; index < rows.length - 1; index++) {
            const before = f.state(),
                plan = planPetSoulUpgrade(f.tables, before, f.pet()),
                packets = f.up()
            assert.equal(publishedPet(f, packets).soul_link_level, plan.value)
            for (const cost of plan.costs)
                assert.equal(amount(before, cost.type, cost.id) - amount(f.state(), cost.type, cost.id), cost.num)
        }
        const max = f.pet().soul_link_level,
            progress = structuredClone(f.state().petStarSoulProgress)
        assert.equal(petSoulRow(f.tables, f.pet()).row.type, 3)
        const before = f.snapshot()
        assert.throws(f.up, (error) => error.code === ErrorCode.PetSoulMaxLevel)
        assert.deepEqual(f.snapshot(), before)
        f.edit((state) => {
            state.pets.find((pet) => pet.guid === f.guid).lv = 1
        })
        f.login()
        assert.equal(f.pet().soul_link_level, max)
        assert.deepEqual(
            f.state().petStarSoulProgress,
            progress,
            'Re-login and a lower pet LV do not revoke already earned facts',
        )
    } finally {
        f.store.close()
    }
})

test('current material shortage and6517 encoding failures roll back currencies, soul nodes, skills and accumulated facts', () => {
    const f = fixture('rollback'),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        f.edit((state) => {
            const pet = state.pets.find((pet) => pet.guid === f.guid)
            pet.lv = 50
            pet.soul_link_level = packed(2, 2)
            state.player.sbag_infos.items = []
        })
        const before = f.snapshot()
        assert.throws(f.up, (error) => error.code === ErrorCode.ItemNotEnough)
        assert.deepEqual(f.snapshot(), before)
        const row = petSoulRow(f.tables, f.pet()).row
        f.edit((state) =>
            grantRewards(
                f.tables,
                state,
                parseRewards(row.item).filter((reward) => reward.itemtype === 3),
            ),
        )
        const prepared = f.snapshot(),
            rsp = f.protocol.byId.get(6517).rsp
        f.protocol.encode = (name, value) => {
            if (name === rsp) throw Error('soul pet sync codec')
            return encode(name, value)
        }
        assert.throws(f.up, /soul pet sync codec/)
        assert.deepEqual(f.snapshot(), prepared)
        f.protocol.encode = encode
        publishedPet(f, f.up())
        assert.equal(f.pet().soul_link_level, packed(2, 3))
        const malformed = structuredClone(f.pet())
        malformed.lv = NaN
        assert.throws(
            () => planPetSoulUpgrade(f.tables, f.state(), malformed),
            (error) => error.code === ErrorCode.GameConfig,
        )
        const badTables = Object.create(f.tables),
            currentId = petSoulRow(f.tables, f.pet()).row.id
        badTables.get = (name) =>
            name === 'pet_starsoul'
                ? f.tables.get(name).map((row) => (row.id === currentId ? { ...row, unlocklevel: -1 } : row))
                : f.tables.get(name)
        assert.throws(
            () => planPetSoulUpgrade(badTables, f.state(), f.pet()),
            (error) => error.code === ErrorCode.PetSoulLinkConfig,
        )
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
