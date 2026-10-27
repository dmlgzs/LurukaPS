import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeModelFixture } from './pet-model-home-fixture.js'

test('5001 explicitly repairs only idle home model bindings atomically with core repair, preserves owned inventory and file reopen, and is idempotent', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'pet-model-home-login-')),
        file = path.join(dir, 'state.db')
    let f = homeModelFixture('pet-model-home-login', file)
    try {
        f.oldBad()
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                const p = s.pets.find((p) => p.guid === '500638'),
                    idle = structuredClone(p)
                idle.guid = '5006380'
                idle.work_status = 0
                idle.work_build = 777
                idle.capacity_id = 888
                s.pets.push(idle)
                Object.assign(p, { work_status: 7, work_build: 0, capacity_id: 0 })
                // Deliberately inconsistent old save exercises both repair
                // branches and the single shared petRevision increment.
                const hero = s.player.heros_info.heros[0]
                hero.pet_id = p.guid
                p.hero_id = hero.guid
                s.player.group_mgrs.find((m) => m.type === 1).groups.find((g) => g.id === 1).heros[0].pet_id = p.guid
                const valid = s.pets.find((p) => p.config_id !== 500638 && !p.work_status)
                valid.work_status = 7
                valid.work_build = 0
                valid.capacity_id = 0
                s.home.stationPets = [p.guid, idle.guid, valid.guid]
            },
            { defer: true },
        )
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol),
            types = [f.protocol.byName.get('CSProtoPetInfoSync').rsp, f.protocol.byName.get('CSProtoHomeSync').rsp]
        for (const type of types) {
            f.protocol.encode = (name, value) => {
                if (name === type) throw Error('home-login-codec')
                return encode(name, value)
            }
            assert.throws(() => f.call('EnterGame', { open_id: f.name }, {}), /home-login-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER home_model_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'home-login-sql'); END",
        )
        assert.throws(() => f.call('EnterGame', { open_id: f.name }, {}), /home-login-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.store.db.exec('DROP TRIGGER home_model_abort')
        f.call('EnterGame', { open_id: f.name }, {})
        const after = f.state(),
            revision = after.petRevision
        assert.equal(after.pets.length, before.pets.length)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(after.home.builds, before.home.builds)
        assert.deepEqual(after.home.ranches, before.home.ranches)
        assert.equal(after.pets.find((p) => p.guid === '500638').work_status, 0)
        assert.deepEqual(
            after.pets.find((p) => p.guid === '5006380'),
            before.pets.find((p) => p.guid === '5006380'),
        )
        assert.deepEqual(
            after.home.stationPets,
            before.home.stationPets.filter((id) => !['500638', '5006380'].includes(id)),
        )
        assert.equal(after.homeRevision, (before.homeRevision ?? 0) + 1)
        assert.equal(revision, (before.petRevision ?? 0) + 1)
        f.call('EnterGame', { open_id: f.name }, {})
        assert.equal(f.state().petRevision, revision)
        f.store.close()
        f = homeModelFixture('pet-model-home-login', file)
        assert.equal(f.state().pets.find((p) => p.guid === '500638').work_status, 0)
        assert(!f.state().home.stationPets.includes('500638'))
        assert(!f.state().home.stationPets.includes('5006380'))
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('pet-model-home-login-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
