import { ErrorCode } from '../error-codes.js'
import { u64 } from '../combat-state.js'
import { enemyDefinition } from '../enemy-state.js'
import { actor } from './combat.js'
import { ensure } from './common.js'

const fields = [
    'dispatch_event_msg',
    'media_pack_play_msg',
    'custom_media_pack_play_msg',
    'dissolve_entity_msg',
    'set_prefab_effect_active_msg',
    'play_voice_msg',
    'set_perform_action_msg',
    'stop_perform_action_ms',
]
const int32 = (value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff
const uint32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const text = (value) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 256 && !value.includes('\0')
function unit(c, value) {
    const id = u64(value),
        kind = Number(BigInt(id) >> 56n)
    ensure(id !== '0', 'Presentation unit is missing', ErrorCode.InvalidTarget)
    if ([3, 4, 7].includes(kind)) {
        ensure(
            enemyDefinition(c.tables, c.state, id),
            'Presentation unit is not in the current scene',
            ErrorCode.InvalidTarget,
        )
    } else {
        ensure([1, 2, 5, 9, 30, 31].includes(kind), 'Unsupported presentation unit kind', ErrorCode.InvalidTarget)
        actor(c, id)
    }
}
export function registerPresentation(on) {
    on('PresentationMsgs', (c, request) => {
        // LOCAL resource bounds, not claimed official batch/name limits.
        const payload = Object.fromEntries(fields.map((key) => [key, request[key] ?? []]))
        ensure(
            fields.every((key) => Array.isArray(payload[key])) &&
                fields.reduce((n, key) => n + payload[key].length, 0) <= 256,
            'Presentation batch exceeds limits',
            ErrorCode.InvalidArgument,
        )
        for (const key of fields)
            for (const message of payload[key]) {
                unit(c, message.unit_id)
                let valid = true
                if (key === 'dispatch_event_msg') {
                    ensure(message.eventType === 4, 'Unsupported presentation event type', ErrorCode.FunctionClosed)
                    valid = int32(message.intValue1 ?? 0) && int32(message.intValue2 ?? 0)
                } else if (key === 'media_pack_play_msg') {
                    valid =
                        text(message.effectKey) &&
                        !!message.effectKey.length &&
                        int32(message.duration ?? 0) &&
                        uint32(message.bindType ?? 0) &&
                        ['x', 'y', 'z'].every((axis) => int32(message.offset?.[axis] ?? 0))
                } else if (key === 'custom_media_pack_play_msg') valid = uint32(message.battleEvent ?? 0)
                else if (key === 'dissolve_entity_msg')
                    valid =
                        int32(message.time ?? 0) &&
                        (message.isShow === undefined || typeof message.isShow === 'boolean')
                else if (key === 'set_prefab_effect_active_msg')
                    valid =
                        (message.active === undefined || typeof message.active === 'boolean') &&
                        ['effectNames', 'meshNames'].every(
                            (name) =>
                                Array.isArray(message[name] ?? []) &&
                                (message[name] ?? []).length <= 128 &&
                                (message[name] ?? []).every(text),
                        )
                else if (key === 'play_voice_msg') valid = int32(message.voiceId ?? 0)
                else if (key === 'set_perform_action_msg')
                    valid =
                        uint32(message.actionType ?? 0) &&
                        text(message.animName ?? '') &&
                        ['crossfadeTime', 'waitTime', 'performID'].every((name) => int32(message[name] ?? 0)) &&
                        ['hideHud', 'needAutoStop'].every(
                            (name) => message[name] === undefined || typeof message[name] === 'boolean',
                        )
                else if (key === 'stop_perform_action_ms') valid = int32(message.performID ?? 0)
                ensure(valid, 'Invalid presentation message', ErrorCode.InvalidArgument)
            }
        const city = c.tables.find('world_city', c.state.world.map_id)
        ensure(city, 'Presentation scene configuration unavailable', ErrorCode.GameConfig)
        // The owner already performed these effects. Current private dungeons
        // have no shared-room identity; a map-only relay would cross instances.
        if (city.type === 1 && fields.some((key) => payload[key].length))
            c.broadcast({ kind: 'map', map: c.state.world.map_id, sender: c.id }, 'SCProtoPresentationMsgsNtf', payload)
        // 11221 deliberately has no ACK, combat mutation or persistent history.
    })
}
