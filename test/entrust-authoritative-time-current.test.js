import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { materialServerFixture } from './material-blueprint-current-fixture.js'

test('30101 explicit stages use authoritative time for unfinished9507 and actual victory9975 with SQL rollback', () => {
    const f = materialServerFixture('entrust-current-authoritative-time')
    try {
        const origin = structuredClone(f.state().world),
            staminaBeforeEntry = f.stamina(),
            config = f.catalog.get(30101, 'material')
        const explicit = f.tables
            .get('worldmap_' + config.scene.id)
            .flatMap((row) => {
                const token = String(row.expandParams ?? '')
                    .split('|')
                    .find((part) => /^autoBattleIndex#/i.test(part))
                return token ? [{ index: Number(token.split('#')[1]), id: row.id }] : []
            })
            .sort((a, b) => a.index - b.index)
        assert.equal(explicit.length, 4)
        assert.deepEqual(
            f.catalog.stages(30101, 'material').map((stage) => ({ index: stage.index, id: stage.row.id })),
            explicit,
        )
        f.begin(30101)
        assert.equal(f.stamina(), staminaBeforeEntry)
        const stages = f.catalog.stages(30101, 'material')
        f.interact(stages[0].row.id)
        f.hurt(stages.find((stage) => stage.type === 50).row.id, { partial: true })
        const partial = f.state()
        assert.equal(partial.entrust.run.status, 2)
        // A successful automatic kill already sets status3 and bypasses this
        // caller. The real premature report exercises its timestamp argument
        // while retaining the authoritative unfinished-enemy rejection.
        assert.throws(
            () => f.call('EndDungeonScene', { result: 3 }),
            (error) => error.code === ErrorCode.InvalidArgument && error.message === 'Entrust enemies are not defeated',
        )
        assert.deepEqual(f.state(), partial)
        f.win()
        assert.equal(f.run().status, 3)
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
        for (const stage of stages.filter((stage) => stage.type === 50)) {
            const dead = Object.values(f.state().combat.entities).filter((enemy) => enemy.object_id === stage.row.id)
            assert(dead.length > 0)
            assert(
                dead.every((enemy) => enemy.hp === 0 && enemy.alive_state === 1),
                'actual HP transitions prove every enemy is dead',
            )
        }
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().materialDungeonRecords[30101].success_count, 1)
        assert.equal(f.stamina(), staminaBeforeEntry, '9507 success does not pay the chest')

        const before = f.state(),
            accountId = before.player.basic_info.id
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
        const entry = f.protocol.byName.get('CSProtoStaminaBoxGet'),
            encode = f.protocol.encode
        let faults = 0
        f.protocol.encode = function (name, ...args) {
            if (name === entry.rsp) {
                faults++
                throw Error('entrust authoritative time response codec')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(
                () => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }),
                /entrust authoritative time response codec/,
            )
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(faults, 1, 'fault must occur in the real claim response encoder')
        assert.deepEqual(f.state(), before)
        assert.deepEqual(rawSQL(), sqlBefore)
        assert.strictEqual(f.store.pending.get(accountId), pending)
        assert.strictEqual(f.store.pending.get(accountId)?.state, pendingState)
        assert.deepEqual(f.store.pending.get(accountId), pendingSnapshot)

        const response = f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }))
        assert(response.reward.rewards.length > 0)
        assert.equal(f.stamina(), staminaBeforeEntry - f.tables.find('dungeon_material', 30101).stamina)
        const after = f.state(),
            oldGUIDs = new Set((before.ornaments ?? []).map((row) => String(row.guid)))
        const equipment = response.reward.rewards.filter((row) => row.itemtype === 15)
        for (const reward of equipment) {
            assert(!oldGUIDs.has(String(reward.guid)))
            assert.equal(after.ornaments.find((row) => String(row.guid) === String(reward.guid))?.id, reward.itemid)
        }
        const qty = (s, id) =>
            (s.player.sbag_infos.items ?? [])
                .filter((row) => row.itemtype === 3 && row.itemid === id)
                .reduce((n, row) => n + row.itemnum, 0)
        const materials = new Map()
        for (const reward of response.reward.rewards.filter((row) => row.itemtype === 3))
            materials.set(reward.itemid, (materials.get(reward.itemid) ?? 0) + reward.itemnum)
        for (const [id, count] of materials) assert.equal(qty(after, id) - qty(before, id), count)
        const paidOrnaments = structuredClone(after.ornaments),
            paidBag = structuredClone(after.player.sbag_infos),
            paidStamina = f.stamina()
        assert.deepEqual(
            f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
            [],
        )
        assert.deepEqual(f.state().ornaments, paidOrnaments)
        assert.deepEqual(f.state().player.sbag_infos, paidBag)
        f.login()
        assert.deepEqual(
            f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
            [],
        )
        assert.equal(f.stamina(), paidStamina)
        assert.deepEqual(f.state().ornaments, paidOrnaments)
        assert.deepEqual(f.state().player.sbag_infos, paidBag)
        f.call('MultiCampaignQuit')
        assert.equal(f.run(), undefined)
        assert.equal(f.state().world.map_id, origin.map_id)
        assert.deepEqual(f.state().world.pos, origin.pos)
    } finally {
        f.close()
    }
})
