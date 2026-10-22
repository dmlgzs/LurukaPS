import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture } from './cult-archive-fixture.js'
function setup(f, archive = false) {
    f.start()
    if (archive) {
        f.complete()
        f.call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
    }
    f.store.transact(f.session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
        if (!archive)
            Object.assign(s.activities[60001].growup, {
                cur_stage: 1,
                cur_growup_trail_stage: 1,
                select_trail_id: 101,
                cur_growup_stage: 4,
            })
    })
}
function worlds(f, packets) {
    return packets.filter((x) => x.id === 9103).map((x) => f.protocol.decode('cs.WorldMapNotify', x.payload))
}
function values(packet) {
    return packet.extra_data.activity_attr.attrs.map((x) => ({ attr_id: x.attr_id, attr_val: String(x.attr_val) }))
}
const expected = (g) => g.growup_train_attr.map((x) => ({ attr_id: x.attr_id, attr_val: String(x.attr_value) }))
test('9610 ordinary cultivation sends actual current ACTIVITY_ATTR values at entry and scene loading, without resending for ordinary hits', () => {
    const f = fixture('cult-formula-current')
    try {
        setup(f)
        const attrs = expected(f.g()),
            entry = f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
        assert.deepEqual(values(worlds(f, entry).find((x) => x.cmd === 256)), attrs)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growup.growup_train_attr[0].attr_value = 401
        })
        const loaded = f.call('MultiCampaignPlayerLoaded')
        assert.deepEqual(values(worlds(f, loaded).find((x) => x.cmd === 47)), expected(f.g()))
        const s = f.state(),
            target = Object.values(s.combat.entities).find((x) => x.object_id === 5),
            hit = f.call('BattleInfoReduce', {
                uint64_dic: [s.cultTrial.pets[0].guid, target.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
                base_time: '0',
            })
        assert.equal(worlds(f, hit).length, 0, 'No activity context snapshot on a nonfatal ordinary hit')
    } finally {
        f.store.close()
    }
})
test('9610 archive formula context always uses the independent snapshot, and restart replaces a pending zero reset with this run values', () => {
    const f = fixture('cult-formula-archive')
    try {
        setup(f, true)
        const archive = f.state().activities[60001].growupArchive.archive[0],
            request = { activity_id: 60001, trial_id: 306, archive_id: 1 },
            entry = f.call('EnterCultTrial', request)
        assert.deepEqual(values(worlds(f, entry).find((x) => x.cmd === 256)), expected(archive))
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growup.growup_train_attr.forEach((x) => (x.attr_value = 7))
        })
        const loaded = f.call('MultiCampaignPlayerLoaded')
        assert.deepEqual(values(worlds(f, loaded).find((x) => x.cmd === 47)), expected(archive))
        const restarted = f.call('ReEnterCultTrial', request)
        assert.deepEqual(values(worlds(f, restarted).find((x) => x.cmd === 256)), expected(archive))
        assert.equal(f.state().pendingCultActivityAttrReset, undefined)
    } finally {
        f.store.close()
    }
})
test('9610 exit and direct map changes explicitly overwrite retired cultivation keys with zero; encoding failure restores the active context', () => {
    const f = fixture('cult-formula-reset')
    try {
        setup(f, true)
        const request = { activity_id: 60001, trial_id: 306, archive_id: 1 }
        f.call('EnterCultTrial', request)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.WorldMapNotify' && value.map_id === 200 && value.extra_data)
                throw Error('formula context codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('WorldPoint', { point_id: 0 }), /formula context codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        const exit = f.call('WorldPoint', { point_id: 0 }),
            reset = worlds(f, exit).find((x) => x.map_id === 200)
        assert(values(reset).every((x) => x.attr_val === '0'))
        assert.deepEqual(
            values(reset).map((x) => x.attr_id),
            before.cultTrial.archive.growup_train_attr.map((x) => x.attr_id),
        )
        assert.equal(f.state().pendingCultActivityAttrReset, undefined)
        f.call('EnterCultTrial', request)
        const change = f.call('EnterWorldMap', { map_id: 200, point_id: 20005 })
        assert(values(worlds(f, change).find((x) => x.map_id === 200)).every((x) => x.attr_val === '0'))
        assert.equal(f.state().cultTrial, undefined)
    } finally {
        f.store.close()
    }
})
test('9610 SQLite reconnect resends archive ACTIVITY_ATTR on the actual dungeon-enter/load callbacks', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'cult-formula-')),
        file = path.join(temp, 'state.sqlite')
    let f = fixture('cult-formula-reconnect', file)
    try {
        setup(f, true)
        f.call('EnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        const archive = f.state().cultTrial.archive
        f.store.close()
        f = fixture('cult-formula-reconnect', file, true)
        const enter = f.call('EnterDungeonScene', { scene_id: 6557 }),
            loaded = f.call('MultiCampaignPlayerLoaded')
        assert.deepEqual(values(worlds(f, enter).find((x) => x.cmd === 256)), expected(archive))
        assert.deepEqual(values(worlds(f, loaded).find((x) => x.cmd === 47)), expected(archive))
        assert.equal(f.g().cur_starting_id, 0)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(temp)) !== parent || !path.basename(temp).startsWith('cult-formula-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(temp, { recursive: true, force: true })
    }
})
