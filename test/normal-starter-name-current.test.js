import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-initial-name-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ createNormalStarterFixture }, { normalCreatorDriver }, { ErrorCode }] = await Promise.all([
    import('./normal-starter-current-fixture.js'),
    import('./normal-starter-creator-driver.js'),
    import('../src/error-codes.js'),
])
const bytes = (text) => Buffer.from(text, 'utf8').toString('base64')
function assertRejectedUnchanged(f, name, request) {
    f.store.flushPending()
    const before = f.store.load(f.session().id)
    const sql = f.store.db.prepare('SELECT state, revision FROM players WHERE account_id=?').get(f.session().id)
    assert.throws(
        () => f.call(name, request),
        (error) => error.code === ErrorCode.InvalidNick,
    )
    assert.deepEqual(f.store.load(f.session().id), before)
    assert.deepEqual(
        f.store.db.prepare('SELECT state, revision FROM players WHERE account_id=?').get(f.session().id),
        sql,
    )
}
test('normal first5010 uses current name rules and rolls back persona before valid task completion', () => {
    const f = createNormalStarterFixture('normal-first-name', { traceDirectory: path.join(artifacts, 'trace') })
    try {
        const { persona } = normalCreatorDriver(f).reachPendingCreator()
        for (const name of [
            undefined,
            bytes('1234567'),
            bytes('123456７'),
            bytes('A\uFEFFB'),
            Buffer.from([0xc3, 0x28]).toString('base64'),
            bytes('A'.repeat(15)),
            '',
        ]) {
            assertRejectedUnchanged(f, 'PlayerCustomData', {
                name,
                wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 1 },
            })
            assert.equal(f.state().normalStarterAvatar.phase, 'provisional')
            assert.notEqual(f.state().characterCustomized, true)
        }
        const name = bytes('Name123456')
        f.call('PlayerCustomData', { name, wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 1 } })
        assert.equal(f.state().player.basic_info.name, name)
        assert.equal(f.state().characterCustomized, true)
        assert.equal(f.state().player.heros_info.heros.length, 1)
        assert.equal(f.state().player.heros_info.heros[0].guid, persona.guid)
        assert.equal(f.state().player.heros_info.heros[0].conf_id, 199002)
        assert.equal(f.state().pendingCharacterTask, undefined)
        assert.equal(f.state().player.sbag_infos.items.find((row) => row.itemid === 1000001).itemnum, 1)
        f.login()
        assert.equal(f.state().player.basic_info.name, name)
    } finally {
        f.close()
    }
})
test('initial digit budget remains after actual editor selected the persona before first5010', () => {
    const f = createNormalStarterFixture('normal-editor-before-name', { traceDirectory: path.join(artifacts, 'trace') })
    try {
        f.login()
        const guid = f.state().player.heros_info.heros[0].guid
        f.call('PinchFaceDataUp', { sex: 1 })
        assert.equal(f.state().normalStarterAvatar.phase, 'selected')
        assert.notEqual(f.state().characterCustomized, true)
        assertRejectedUnchanged(f, 'PlayerCustomData', {
            name: bytes('1234567'),
            wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 2 },
        })
        const name = bytes('Create123456')
        f.call('PlayerCustomData', { name, wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 2 } })
        assert.equal(f.state().player.basic_info.name, name)
        assert.equal(f.state().characterCustomized, true)
        assert.equal(f.state().player.heros_info.heros[0].guid, guid)
        assert.equal(f.state().player.heros_info.heros[0].conf_id, 199001)
        assert.equal(f.state().pets.length, 0)
    } finally {
        f.close()
    }
})
test('unmarked legacy login preserves old name and owned assets without retroactive name validation', () => {
    const f = createNormalStarterFixture('legacy-keeps-original-name', {
        legacy: true,
        traceDirectory: path.join(artifacts, 'trace'),
    })
    try {
        const name = f.baseline.player.basic_info.name
        const assets = f.baseline.player.heros_info.heros.map(({ guid, conf_id }) => ({ guid, conf_id }))
        f.login()
        assert.equal(f.state().starterProfile, undefined)
        assert.equal(f.state().player.basic_info.name, name)
        assert.deepEqual(
            f.state().player.heros_info.heros.map(({ guid, conf_id }) => ({ guid, conf_id })),
            assets,
        )
    } finally {
        f.close()
    }
})
