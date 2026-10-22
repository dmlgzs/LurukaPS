import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { validateSceneShowcase } from '../scene-showcase.js'

export function registerSceneShowcase(on, tables) {
    on('ChangeSceneShowcase', (c, r) => {
        const data = validateSceneShowcase(tables, c.state, r.data, c.id)
        const basic = c.state.player.basic_info
        const previous = basic.scene_showcase ?? []
        ensure(
            Array.isArray(previous) &&
                previous.every((s) => s && Number.isInteger(s.id) && s.id > 0) &&
                new Set(previous.map((s) => s.id)).size === previous.length,
            'Invalid saved scene showcase slots',
            ErrorCode.GameConfig,
        )
        basic.scene_showcase = [...previous.filter((s) => s.id !== data.id), data].sort((a, b) => a.id - b.id)
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { scene_showcase: basic.scene_showcase } })
        return {}
    })
}
