import { ErrorCode } from '../error-codes.js'
import { ensure, syncPets } from './common.js'

export function registerKiboTours(on, catalog) {
    on('StartKiboTour', (c, r) => {
        const row = catalog.rows.find(row => row.id === r.activity_id)
        ensure(row, 'Kibo tour activity configuration missing', ErrorCode.NoActivityConf)
        ensure(row.type === 80, 'Activity does not support Kibo tours', ErrorCode.ActivityTypeNotEqual)
        ensure(catalog.unlocked(row, c.state), 'Kibo tour activity prerequisite is not complete', ErrorCode.ActivityConditionNone)
        const result = catalog.tours.start(c.state, catalog.entry(c.state, row.id), row, r, c.now, catalog.window(row, c.now))
        if (result.created) syncPets({ ...c, push: c.pushBefore })
        catalog.notify(c, true)
        return {}
    })
}
