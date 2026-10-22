import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function petBoxCount(tables) {
    const count = Number(tables.get('game').find((row) => row.title === 'PET_BOX_NUM')?.value)
    ensure(Number.isInteger(count) && count > 0 && count <= 0xffffffff, 'Invalid pet box count', ErrorCode.GameConfig)
    return count
}

export function lockedPetBoxes(tables, state) {
    const count = petBoxCount(tables),
        ids = state.lockedPetBoxes ?? []
    ensure(
        Array.isArray(ids) &&
            ids.every((id) => Number.isInteger(id) && id >= 1 && id <= count) &&
            new Set(ids).size === ids.length &&
            ids.length < count,
        'Invalid pet box lock state',
        ErrorCode.GameConfig,
    )
    return [...ids].sort((a, b) => a - b)
}

export function changePetBoxLock(c, r) {
    const count = petBoxCount(c.tables),
        ids = lockedPetBoxes(c.tables, c.state)
    ensure(
        Number.isInteger(r.box_id) && r.box_id >= 1 && r.box_id <= count,
        'Pet box does not exist',
        ErrorCode.PetBoxNotExist,
    )
    ensure(r.lock_operate === 0 || r.lock_operate === 1, 'Invalid pet box lock operation', ErrorCode.PetLockOperate)
    if (r.lock_operate === 1) {
        ensure(!ids.includes(r.box_id), 'Pet box already locked', ErrorCode.PetBoxAlreadlyLock)
        ensure(ids.length + 1 < count, 'Cannot lock every pet box', ErrorCode.PetBoxNotAllowLockAll)
        ids.push(r.box_id)
    } else if (ids.includes(r.box_id)) ids.splice(ids.indexOf(r.box_id), 1)
    c.state.lockedPetBoxes = ids.sort((a, b) => a - b)
    c.pushBefore('CSProtoPetInfoSync', { lock_box_id: c.state.lockedPetBoxes })
    return {}
}
