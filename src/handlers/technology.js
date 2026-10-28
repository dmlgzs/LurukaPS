import { ErrorCode } from '../error-codes.js'
import { spendTechnologyPoints } from '../technology-points.js'
import { ensureHome } from '../home.js'
import { homeCondition } from '../home-grid.js'
import { technologyState, technologyParents, technologyType } from '../technology.js'
import { ensure } from './common.js'
export function registerTechnology(on, tables) {
    on('HomeTechnologyFirstOpen', (c, r) => {
        ensureHome(tables, c.state)
        const tech = technologyState(tables, c.state),
            tree = tables.find('home_technology_tree', r.subType)
        ensure(tree && tree.category === r.type, 'Technology does not belong to category')
        const record = tech.levels[tree.id]
        ensure(record?.level > 0, 'Technology is not unlocked')
        if (record.isOpened !== true) {
            record.isOpened = true
            c.state.homeRevision = (c.state.homeRevision || 0) + 1
        }
        return {}
    })
    on('HomeTechnologyTypeInfo', (c, r) => {
        ensureHome(tables, c.state)
        return { info: technologyType(tables, c.state, r.type) }
    })
    on('HomeTechnologyLevelUp', (c, r) => {
        ensureHome(tables, c.state)
        const tech = technologyState(tables, c.state),
            tree = tables.find('home_technology_tree', r.subType)
        ensure(tree && tree.category === r.type, 'Technology does not belong to category')
        const level = tech.levels[tree.id]?.level || 0
        if (tree.isAutoUnlock === 1) {
            ensure(level > 0, 'Technology level requirement not met')
            // Older local clients requested a level-up for an automatic node.
            // Acknowledge its existing level without charging or upgrading it.
            tech.levels[tree.id].isOpened = true
            c.state.homeRevision = (c.state.homeRevision || 0) + 1
            return { errorCode: 0 }
        }
        const row = tables.get('home_technology').find((x) => x.type === tree.id && x.level === level + 1)
        ensure(row, 'Technology is at maximum level')
        ensure(technologyParents(tree, tech), 'Prerequisite technology missing')
        ensure(homeCondition(row.unlockCondi1, c.state), 'Technology level requirement not met')
        ensure(Number.isInteger(row.point) && row.point >= 0, 'Invalid technology cost', ErrorCode.GameConfig)
        spendTechnologyPoints(tables, c.state, row.point)
        tech.levels[tree.id] = { level: level + 1, lastTime: c.now }
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return { errorCode: 0 }
    })
}
