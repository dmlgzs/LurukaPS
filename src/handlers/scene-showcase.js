import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { sceneShowcaseSlot, validateSceneShowcase } from '../scene-showcase.js'

export function registerSceneShowcase(on, tables) {
    on('ChangeShowcaseId', (c, r) => {
        sceneShowcaseSlot(tables, c.state, r.u32)
        // situationState constructs an unlocked slot locally before its first save.
        // Selecting it must not require nor manufacture a persisted 6143 record.
        const basic = c.state.player.basic_info
        basic.show_case_id = r.u32
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: { show_case_id: r.u32 } })
        return {}
    })
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
