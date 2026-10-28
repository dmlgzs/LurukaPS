import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { productionWorkGameFixture } from './production-work-game-fixture.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('a failed managed login cannot bypass the missing model through an ordinary production observer', () => {
    const parent = path.resolve(os.tmpdir()),
        directory = fs.mkdtempSync(path.join(parent, 'work-model-request-')),
        file = path.join(directory, 'state.sqlite'),
        name = 'work-model-request'
    let f, store
    try {
        f = productionWorkGameFixture(name, { file, satiety: 60 })
        f.start(3)
        f.advance(1)
        const id = f.session.id,
            protocol = f.protocol,
            tables = f.tables,
            now = f.now() + 10
        f.close()
        f = null
        store = new Store(file)
        const game = new Game(protocol, store, tables, { clock: () => now }),
            session = {},
            row = () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(id),
            before = row()
        let sequence = 1
        const call = (name, data = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, {
                id: entry.id,
                seq: sequence++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
        }
        assert.throws(
            () => call('EnterGame', { open_id: name }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.equal(session.id, id)
        assert(!session.entered)
        assert.deepEqual(row(), before)
        let rejected, packets
        try {
            packets = call('ActivityGet')
        } catch (error) {
            rejected = error
        }
        const after = row(),
            output = process.env.LURUKAPS_RECOVERY_PROBE_OUTPUT
        if (output) {
            const evidence = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', output)
            fs.mkdirSync(evidence, { recursive: true })
            fs.writeFileSync(
                path.join(evidence, 'ordinary-request.json'),
                JSON.stringify(
                    {
                        code: rejected?.code ?? null,
                        message: rejected?.message ?? null,
                        packets: packets?.length ?? null,
                        beforeRevision: before.revision,
                        afterRevision: after.revision,
                        rowUnchanged: before.state === after.state && before.revision === after.revision,
                    },
                    null,
                    2,
                ) + '\n',
            )
        }
        assert.equal(rejected?.code, ErrorCode.GameConfig)
        assert.deepEqual(after, before)
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(path.resolve(directory)), parent)
        assert(path.basename(directory).startsWith('work-model-request-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
