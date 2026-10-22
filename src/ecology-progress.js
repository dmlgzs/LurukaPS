import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function ecologyEvent(c, id) {
    const config = c.tables.find('world_eep', id)
    ensure(config, 'Ecology configuration is unavailable', ErrorCode.WorldInvalidEcologyConfig)
    ensure(
        config.worldMapID === c.state.world.map_id,
        'Ecology event is not in this world',
        ErrorCode.WorldInvalidEcology,
    )
    const ecology = c.state.ecology,
        event = ecology?.events?.[id]
    ensure(
        event && ecology.visible?.includes(id),
        'Ecology event was not published in the current world',
        ErrorCode.WorldInvalidEcology,
    )
    const template = c.tables.find('world_eep_template', event.template_id)
    ensure(template, 'Ecology template is unavailable', ErrorCode.WorldInvalidEcologyTemplate)
    const choices = String(config.templateList ?? '')
        .split('|')
        .filter(Boolean)
        .map((part) => part.split('#').map(Number))
    ensure(
        choices.length && choices.every((a) => a.length === 2 && a.every(Number.isSafeInteger) && a[0] > 0 && a[1] > 0),
        'Invalid ecology template list',
        ErrorCode.WorldInvalidEcologyConfig,
    )
    ensure(
        choices.some((a) => a[1] === template.id),
        'Saved ecology template does not belong to the event',
        ErrorCode.WorldInvalidEcology,
    )
    ensure(
        Number.isSafeInteger(template.stepMax) &&
            template.stepMax > 0 &&
            Number.isSafeInteger(template.jumpStep) &&
            template.jumpStep >= 0 &&
            template.jumpStep <= template.stepMax &&
            Number.isSafeInteger(template.overtime) &&
            template.overtime >= 0,
        'Invalid ecology step or timeout configuration',
        ErrorCode.WorldInvalidEcologyTemplate,
    )
    ensure(!template.randomStartStep, 'Ecology randomized start steps are not implemented', ErrorCode.FunctionClosed)
    ensure(
        event.id === id &&
            [event.step, event.status, event.timestamp, event.triggertimes].every(
                (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff,
            ) &&
            [0, 1].includes(event.status),
        'Invalid saved ecology event',
        ErrorCode.WorldInvalidEcology,
    )
    const progress = ecology.progress?.[id] ?? {
        template_id: template.id,
        last_step: event.step,
        terminal_reports: 0,
        ready: false,
        claimed: false,
    }
    ensure(
        progress.template_id === template.id &&
            Number.isSafeInteger(progress.last_step) &&
            progress.last_step >= 0 &&
            Number.isSafeInteger(progress.terminal_reports) &&
            progress.terminal_reports >= 0 &&
            progress.terminal_reports <= 2 &&
            typeof progress.ready === 'boolean' &&
            typeof progress.claimed === 'boolean' &&
            (progress.started_at === undefined ||
                (Number.isSafeInteger(progress.started_at) && progress.started_at >= 0)),
        'Invalid saved ecology progress receipt',
        ErrorCode.WorldInvalidEcology,
    )
    return { config, template, event, progress, ecology }
}
export function saveEcology(c, id, event, progress) {
    const old = c.state.ecology
    c.state.ecology = { ...old, events: { ...old.events, [id]: event }, progress: { ...old.progress, [id]: progress } }
}
export function syncEcologyEvent(c, event, { remove = false } = {}) {
    c.pushBefore('CSProtoWorldEcologySync', {
        event_data: remove ? [] : [event],
        del_event: remove ? [event.id] : [],
        group_data: [],
        del_group: [],
    })
}
export function ecologyTimedOut(template, progress, now) {
    return (
        !progress.ready &&
        !progress.claimed &&
        progress.started_at !== undefined &&
        template.overtime > 0 &&
        now >= progress.started_at + template.overtime
    )
}
export function sweepExpiredEcology(c) {
    const expired = []
    for (const id of c.state.ecology?.visible ?? []) {
        const row = c.tables.find('world_eep', id)
        if (row?.worldMapID !== c.state.world.map_id) continue
        const { template, event, progress } = ecologyEvent(c, id)
        if (!ecologyTimedOut(template, progress, c.now)) continue
        const next = { ...progress, last_step: 0, terminal_reports: 0, ready: false }
        delete next.started_at
        saveEcology(c, id, { ...event, step: 0, timestamp: c.now }, next)
        expired.push(id)
    }
    // The client applies event_data before del_event. Delete in a separate
    // packet, then let the stable refresh publish the reset event snapshot.
    if (expired.length)
        c.pushBefore('CSProtoWorldEcologySync', { event_data: [], del_event: expired, group_data: [], del_group: [] })
}
export function advanceEcology(c, request) {
    const { template, event, progress } = ecologyEvent(c, request.id),
        step = request.step ?? 0
    ensure(
        Number.isSafeInteger(step) && step >= 0 && step <= 0xffffffff,
        'Invalid ecology step',
        ErrorCode.WorldInvalidEcology,
    )
    if (event.status === 1 || progress.claimed) {
        if (step === 0) syncEcologyEvent(c, event, { remove: true })
        return {}
    }
    if (step === 0) {
        if (progress.ready) {
            saveEcology(c, event.id, event, { ...progress, closed: true })
            return {}
        }
        const next = { ...progress, last_step: 0, terminal_reports: 0, ready: false, closed: true }
        delete next.started_at
        saveEcology(c, event.id, { ...event, step: 0 }, next)
        syncEcologyEvent(c, c.state.ecology.events[event.id])
        return {}
    }
    // EEP can play presentation actions beyond its reward checkpoint. Once
    // completion is evidenced, these reports do not revoke or regrant loot.
    if (progress.ready) return {}
    ensure(
        !ecologyTimedOut(template, progress, c.now),
        'Ecology attempt timed out; refresh to restart',
        ErrorCode.WorldInvalidEcology,
    )
    ensure(
        step <= template.stepMax &&
            (step === progress.last_step ||
                step === progress.last_step + 1 ||
                (template.jumpStep > 0 && progress.last_step >= template.jumpStep && step === template.jumpStep) ||
                (template.jumpStep === 0 && step === 1)),
        'Ecology step is out of sequence',
        ErrorCode.WorldInvalidEcology,
    )
    const next = { ...progress, last_step: step, closed: false }
    let triggers = event.triggertimes
    if (next.started_at === undefined) {
        next.started_at = c.now
        ensure(triggers < 0xffffffff, 'Ecology trigger count overflow', ErrorCode.WorldInvalidEcology)
        triggers++
    }
    if (step === template.stepMax) {
        next.terminal_reports = Math.min(2, next.terminal_reports + 1)
        next.ready = next.terminal_reports === 2
    }
    saveEcology(c, event.id, { ...event, step, timestamp: next.started_at, triggertimes: triggers }, next)
    syncEcologyEvent(c, c.state.ecology.events[event.id])
    return {}
}
