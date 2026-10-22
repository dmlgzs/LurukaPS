import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function cultActivityAttributes(state) {
    const run = state.cultTrial
    if (!run || run.map_id !== state.world.map_id) return null
    const attrs = run.archive?.growup_train_attr ?? state.activities?.[run.activity_id]?.growup?.growup_train_attr
    ensure(
        Array.isArray(attrs) &&
            attrs.length > 0 &&
            new Set(attrs.map((x) => x.attr_id)).size === attrs.length &&
            attrs.every(
                (x) =>
                    Number.isSafeInteger(x.attr_id) &&
                    x.attr_id > 0 &&
                    x.attr_id <= 0x7fffffff &&
                    Number.isSafeInteger(x.attr_value) &&
                    x.attr_value >= 0 &&
                    x.attr_value <= 0x7fffffff,
            ),
        'Invalid cultivation formula attributes',
        ErrorCode.GameConfig,
    )
    return attrs.map((x) => ({ attr_id: x.attr_id, attr_val: String(x.attr_value) }))
}

export function rememberCultActivityAttrReset(state) {
    const run = state.cultTrial
    if (!run) return
    // A scene transfer can change world.map_id before retiring the formation.
    // Read the just-retired run directly instead of requiring the old map.
    const attrs = run.archive?.growup_train_attr ?? state.activities?.[run.activity_id]?.growup?.growup_train_attr
    if (attrs?.length) state.pendingCultActivityAttrReset = attrs.map((x) => ({ attr_id: x.attr_id, attr_val: '0' }))
}

export function cultActivityAttrExtra(state) {
    const active = cultActivityAttributes(state),
        attrs = active ?? state.pendingCultActivityAttrReset
    if (!attrs) return null
    // SceneService's SetActivityAttr overwrites supplied keys; absent keys are
    // retained. An empty repeated field cannot clear a previous scene's values.
    delete state.pendingCultActivityAttrReset
    return { activity_attr: { attrs } }
}
