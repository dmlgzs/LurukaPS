import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ErrorCode } from '../src/error-codes.js'
import { workerAssignmentProgressValue } from '../src/worker-assignment-progress.js'

test('selected permanent worker malformed config identity and valid missing pet config have distinct named errors', () => {
    const tables = new Tables(configuration().tables),
        job = tables.get('home_labor_type')[0].id,
        pet = tables.get('pet')[0],
        state = {
            pets: [
                {
                    guid: '1',
                    config_id: pet.id,
                    work_status: 7,
                    labor_infos: [{ labor_id: job, labor_grade: 1 }],
                },
            ],
            home: { stationPets: ['1'] },
        },
        tokens = [12247, job, 3]
    assert.equal(workerAssignmentProgressValue(tables, state, tokens), 1)
    for (const config of [undefined, null, 0, -1, NaN, 1.5, true, String(pet.id), 0x100000000]) {
        const copy = structuredClone(state)
        copy.pets[0].config_id = config
        assert.throws(
            () => workerAssignmentProgressValue(tables, copy, tokens),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
    assert.equal(tables.find('pet', 0xffffffff), undefined)
    const missing = structuredClone(state)
    missing.pets[0].config_id = 0xffffffff
    assert.throws(
        () => workerAssignmentProgressValue(tables, missing, tokens),
        (error) => error.code === ErrorCode.PetConfNotExist,
    )
    assert.equal(workerAssignmentProgressValue(tables, state, tokens), 1)
})
