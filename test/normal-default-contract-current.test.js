import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-normal-default-contract-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ configuration }, { Tables }, { Protocol }, { Store }, { Game }] = await Promise.all([
    import('../src/config.js'),
    import('../src/player.js'),
    import('../src/protocol.js'),
    import('../src/store.js'),
    import('../src/game.js'),
])
for (const variant of ['omitted-fourth-argument', 'server-style-options-without-profile']) {
    test('current actual EnterGame defaults normal: ' + variant, () => {
        const config = configuration(),
            tables = new Tables(config.tables),
            protocol = new Protocol(config.base),
            store = new Store(':memory:')
        const game =
            variant === 'omitted-fourth-argument'
                ? new Game(protocol, store, tables)
                : new Game(protocol, store, tables, {
                      crcDelay: config.crcDelay ?? 0,
                      gmEnabled: config.gmEnabled ?? true,
                      offlinePayments: config.offlinePayments ?? true,
                      gachaPolicy: config.gachaPolicy,
                      productionWorkPolicy: config.productionWorkPolicy,
                  })
        const entry = protocol.byId.get(5001),
            session = {}
        try {
            assert.equal(game.newAccountStarterProfile, 'normal')
            const packets = game.dispatch(session, {
                id: entry.id,
                seq: 1,
                payload: protocol.encode(entry.req, { open_id: 'sandbox-text-cannot-select-profile-' + variant }),
            })
            const state = store.load(session.id).state
            assert.deepEqual(state.starterProfile, { schemaVersion: 1, mode: 'normal', clientVersion: '1.0.0' })
            assert.equal(state.player.heros_info.heros.length, 1)
            assert.equal(state.pets.length, 0)
            assert.equal(state.player.soulessence_infos.soulessences.length, 0)
            assert.equal(state.player.sbag_infos.items.length, 0)
            assert.deepEqual(state.world.points, [])
            const reply = packets.find((packet) => packet.id === 5001)
            assert(reply)
            const player = protocol.decode(entry.rsp, reply.payload).data
            assert.equal(player.heros_info.heros.length, 1)
            assert.equal(player.basic_info.skip_guide, 0)
            assert(state.tasks.some((task) => task.task_id === 106001))
            for (const packet of packets) {
                const descriptor = protocol.byId.get(packet.id)
                assert(descriptor?.rsp)
                protocol.decode(descriptor.rsp, packet.payload)
            }
        } finally {
            store.close()
        }
    })
}
