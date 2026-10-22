import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { advanceEcology, sweepExpiredEcology } from '../ecology-progress.js'
import { claimEcologyReward } from '../ecology-rewards.js'
export function registerEcology(on, tables) {
    on('WorldEcologyStep', advanceEcology)
    on('WorldEcologyGetReward', claimEcologyReward)
    const configs = tables.get('world_eep'),
        templates = new Map(tables.get('world_eep_template').map((x) => [x.id, x]))
    on('WorldEcologyReset', (c) => {
        sweepExpiredEcology(c)
        const ecology = (c.state.ecology ??= { events: {}, visible: [] })
        const current = configs.filter((row) => row.worldMapID === c.state.world.map_id),
            ids = current.map((row) => row.id)
        for (const row of current)
            if (!ecology.events[row.id]) {
                const choices = String(row.templateList || '')
                    .split('|')
                    .filter(Boolean)
                    .map((part) => {
                        const [weight, id, ...extra] = part.split('#').map(Number)
                        ensure(
                            !extra.length && Number.isSafeInteger(weight) && weight > 0 && templates.has(id),
                            'Invalid ecology template configuration',
                            ErrorCode.WorldInvalidEcologyConfig,
                        )
                        return { weight, id }
                    })
                const total = choices.reduce((n, x) => n + x.weight, 0)
                ensure(
                    total > 0 && total <= 0x7fffffff,
                    'Invalid ecology template weights',
                    ErrorCode.WorldInvalidEcologyConfig,
                )
                let draw = c.randomInt(total),
                    selected
                for (const choice of choices) {
                    draw -= choice.weight
                    if (draw < 0) {
                        selected = choice.id
                        break
                    }
                }
                ecology.events[row.id] = {
                    id: row.id,
                    template_id: selected,
                    step: 0,
                    status: 0,
                    timestamp: c.now,
                    triggertimes: 0,
                }
            }
        const removed = ecology.visible.filter((id) => !ids.includes(id))
        ecology.visible = ids
        ecology.refreshed_at = c.now
        c.pushBefore('CSProtoWorldEcologySync', {
            event_data: ids.map((id) => ecology.events[id]),
            del_event: removed,
            group_data: [],
            del_group: [],
        })
        return {}
    })
}
