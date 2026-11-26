import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { materialServerFixture } from './material-blueprint-current-fixture.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { EntrustCatalog } from '../src/entrust.js'
import { ErrorCode } from '../src/error-codes.js'
import { currentMaterialBlueprintStages } from '../src/material-blueprint-stages.js'

const tables = new Tables(configuration().tables)
const readReply = (f, packets) => f.reply('StaminaBoxGet', packets)

test('fully indexed current material control keeps its explicit automatic marker,enemy and chest order', () => {
    const catalog = new EntrustCatalog(tables),
        config = catalog.get(30101, 'material')
    const explicit = tables
        .get('worldmap_' + config.scene.id)
        .flatMap((row) => {
            const match = String(row.expandParams ?? '')
                .split('|')
                .find((part) => /^autoBattleIndex#/i.test(part))
            return match ? [{ index: Number(match.split('#')[1]), id: row.id }] : []
        })
        .sort((a, b) => a.index - b.index)
    assert.equal(explicit.length, 4, 'control is chosen because all four current anchors are explicit')
    assert.deepEqual(
        catalog.stages(30101, 'material').map((stage) => ({ index: stage.index, id: stage.row.id })),
        explicit,
    )
})

test('current dual client300358/server300351 material routes cover actual victory objects and existing chest anchors', () => {
    for (const id of [30803, 30804, 30604]) {
        const catalog = new EntrustCatalog(tables),
            config = catalog.get(id, 'material'),
            stages = catalog.stages(id, 'material')
        assert.equal(config.scene.blueprintId, 300358)
        assert.equal(config.scene.serverBlueprintId, 300351)
        assert.equal(stages[0].type, 13)
        assert.equal(stages.at(-1).type, 30)
        assert.deepEqual(
            stages
                .filter((stage) => stage.type === 50)
                .map((stage) => stage.row.id)
                .sort((a, b) => a - b),
            catalog
                .victoryObjects(id, 'material')
                .map((row) => row.objectId)
                .sort((a, b) => a - b),
        )
        assert.equal(stages.at(-1).row.id, catalog.chest(id, 'material').worldmapid)
        assert(stages.every((stage, index) => index === 0 || stage.index > stages[index - 1].index))
    }
})

for (const [id, previousClears] of [
    [30803, []],
    [30804, [30803]],
    [30604, [30603]],
]) {
    test(`material${id} current MaterialUI entry, actual HP death, settlement and paid chest replay survive relogin/exit`, () => {
        const f = materialServerFixture('material-current-dual-' + id, { previousClears })
        try {
            const origin = structuredClone(f.state().world),
                beforeStamina = f.stamina()
            f.begin(id)
            const stages = f.catalog.stages(id, 'material'),
                marker = stages[0]
            assert.equal(f.stamina(), beforeStamina, 'entry does not pay chest cost')
            assert.throws(() => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }))
            f.interact(marker.row.id)
            const first = stages.find((stage) => stage.type === 50)
            f.hurt(first.row.id, { partial: true })
            const damaged = f.living(first.row.id).map((enemy) => ({ uuid: enemy.uuid, hp: enemy.hp }))
            f.login()
            for (const enemy of damaged)
                assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.hp, 'relogin does not heal partial damage')
            f.win()
            assert.equal(f.state().materialDungeonRecords[id].success_count, 1)
            const completed = structuredClone(f.state().materialDungeonRecords),
                beforeClaim = f.stamina(),
                beforeAssets = f.state(),
                existingGuids = new Set((beforeAssets.ornaments ?? []).map((item) => String(item.guid)))
            const response = readReply(f, f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }))
            assert(response.reward.rewards.length > 0, 'actual configured drop grant')
            assert.equal(f.stamina(), beforeClaim - f.tables.find('dungeon_material', id).stamina)
            const instanceRewards = response.reward.rewards.filter((reward) => reward.itemtype === 15),
                acquired = (f.state().ornaments ?? []).filter((item) => !existingGuids.has(String(item.guid)))
            assert(instanceRewards.length > 0, 'these current accessory dungeons actually create owned instances')
            assert.equal(acquired.length, instanceRewards.length)
            assert.equal(new Set(acquired.map((item) => String(item.guid))).size, acquired.length)
            for (const reward of instanceRewards) {
                assert.equal(reward.itemnum, 1)
                const owned = acquired.find((item) => String(item.guid) === String(reward.guid))
                assert(owned, 'every acquired GUID must exist in owned ornaments')
                assert.equal(owned.id, reward.itemid)
            }
            const bagCounts = (state, itemId) =>
                state.player.sbag_infos.items
                    .filter((item) => item.itemid === itemId)
                    .reduce((sum, item) => sum + item.itemnum, 0)
            const materialRewards = new Map()
            for (const reward of response.reward.rewards.filter((row) => row.itemtype === 3))
                materialRewards.set(reward.itemid, (materialRewards.get(reward.itemid) ?? 0) + reward.itemnum)
            for (const [itemId, quantity] of materialRewards)
                assert.equal(bagCounts(f.state(), itemId), bagCounts(beforeAssets, itemId) + quantity)
            const paid = structuredClone(f.state().player),
                paidOrnaments = structuredClone(f.state().ornaments),
                afterClaim = f.stamina()
            assert.deepEqual(
                readReply(f, f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
                [],
            )
            assert.deepEqual(f.state().player, paid)
            assert.deepEqual(f.state().ornaments, paidOrnaments)
            f.login()
            assert.deepEqual(
                readReply(f, f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
                [],
            )
            assert.equal(f.stamina(), afterClaim)
            assert.deepEqual(f.state().ornaments, paidOrnaments)
            assert.deepEqual(f.state().materialDungeonRecords, completed)
            f.call('MultiCampaignQuit')
            assert.equal(f.run(), undefined)
            assert.equal(f.state().world.map_id, origin.map_id)
            assert.deepEqual(f.state().world.pos, origin.pos)
            f.login()
            assert.deepEqual(f.state().materialDungeonRecords, completed)
            assert.deepEqual(f.state().ornaments, paidOrnaments)
        } finally {
            f.close()
        }
    })
}

test('current dual graph paid chest reply encoding failure rolls back cost, grants and claim receipt before retry', () => {
    const f = materialServerFixture('material-current-dual-claim-codec')
    try {
        f.begin(30803)
        f.win()
        const before = f.state(),
            entry = f.protocol.byName.get('CSProtoStaminaBoxGet'),
            encode = f.protocol.encode
        const accountId = before.player.basic_info.id
        const rawSQL = () => ({
            player: f.store.db
                .prepare('SELECT state,revision,updated_at FROM players WHERE account_id=?')
                .get(accountId),
            requestLog: f.store.db
                .prepare(
                    'SELECT id,account_id,message_id,status,created_at FROM request_log WHERE account_id=? ORDER BY id',
                )
                .all(accountId),
            sequences: f.store.db.prepare('SELECT name,value FROM sequences ORDER BY name').all(),
        })
        const sqlBefore = rawSQL(),
            pending = f.store.pending.get(accountId),
            pendingState = pending?.state,
            pendingSnapshot = structuredClone(pending)
        let failures = 0
        f.protocol.encode = function (name, ...args) {
            if (name === entry.rsp) {
                failures++
                throw Error('material-current-claim-codec')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(
                () => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }),
                /material-current-claim-codec/,
            )
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(failures, 1, 'failure hook must be actual response encoder, not request encoder')
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            rawSQL(),
            sqlBefore,
            'failed claim preserves raw player bytes,revision,timestamp,request log and GUID sequences',
        )
        assert.strictEqual(
            f.store.pending.get(accountId),
            pending,
            'failed claim cannot publish or replace a deferred record',
        )
        assert.strictEqual(
            f.store.pending.get(accountId)?.state,
            pendingState,
            'failed claim cannot replace the original deferred state',
        )
        assert.deepEqual(
            f.store.pending.get(accountId),
            pendingSnapshot,
            'failed claim cannot mutate the borrowed deferred state',
        )
        assert(readReply(f, f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards.length > 0)
        assert.deepEqual(readReply(f, f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards, [])
    } finally {
        f.close()
    }
})

test('unknown server blueprint and blueprint path drift cannot silently use the current verified stage projection', () => {
    const scene = new EntrustCatalog(tables).get(30803, 'material').scene
    for (const [table, mutate] of [
        [
            'dungeon_scene',
            (rows) => {
                rows.find((row) => row.id === scene.id).serverBlueprintId = 300311
            },
        ],
        [
            'world_blueprint',
            (rows) => {
                rows.find((row) => row.id === 300351).path += '-source-drift'
            },
        ],
    ]) {
        const changed = structuredClone(tables.get(table))
        mutate(changed)
        const view = {
            dir: tables.dir,
            get: (name) => (name === table ? changed : tables.get(name)),
            find(name, id) {
                return this.get(name).find((row) => row.id === id)
            },
        }
        assert.throws(
            () => new EntrustCatalog(view).stages(30803, 'material'),
            (e) => [ErrorCode.GameConfig, ErrorCode.FunctionClosed].includes(e.code),
        )
    }
})

test('current dual graph source SHA,topology SHA and LOCAL policy cannot be self-asserted or silently changed', () => {
    const contract = JSON.parse(
        fs.readFileSync(new URL('../configs/material-front-execution.json', import.meta.url), 'utf8'),
    )
    const config = new EntrustCatalog(tables).get(30803, 'material')
    const indexed = tables
        .get('worldmap_' + config.scene.id)
        .flatMap((row) => {
            const token = String(row.expandParams ?? '')
                .split('|')
                .find((part) => /^autoBattleIndex#/i.test(part))
            return token
                ? [
                      {
                          index: Number(token.split('#')[1]),
                          type: tables.find('world_spawner', row.spawnerId).objectType,
                          row,
                      },
                  ]
                : []
        })
        .sort((a, b) => a.index - b.index)
    assert.equal(currentMaterialBlueprintStages(tables, config.scene, config.material, indexed, contract).length, 4)
    for (const mutate of [
        (value) => {
            value.sourceFingerprint = '0'.repeat(64)
        },
        (value) => {
            value.source.server.graphSha256 = '0'.repeat(64)
        },
        (value) => {
            value.model.waits.reverse()
        },
        (value) => {
            value.policy.origin = 'Native'
        },
    ]) {
        const altered = structuredClone(contract)
        mutate(altered)
        assert.throws(
            () => currentMaterialBlueprintStages(tables, config.scene, config.material, indexed, altered),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
})
