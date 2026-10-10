// Only schemas with verified CBT3 keyed/optional-field merge semantics live
// here. This cache describes SENT data, never persistent game state.
const json = (value) => JSON.stringify(value)
const forceRequests = new Set([
    'CSProtoEnterGame',
    'CSProtoRenterGame',
    'CSProtoCreatePlayer',
    'CSProtoEnterWorldMap',
    'CSProtoWorldPoint',
    'CSProtoEnterHome',
    'CSProtoWorldQuitHome',
    'CSProtoWorldMapReturnLast',
    'CSProtoCampaignCreate',
    'CSProtoCampaignQuit',
    'CSProtoEnterDungeonScene',
    'CSProtoMultiCampaignPlayerLoaded',
    'CSProtoStartDungeonClientOk',
    'CSProtoTrialGroupChange',
    'CSWorldObjAIHeroInfo',
    'CSProtoWorldObjEnemyInfo',
    'CSProtoWorldMapPlayerRevive',
    'CSProtoTaskClientBefore',
    'CSProtoPlayableStart',
    'CSProtoPlayableCancel',
    'CSProtoGMCommand',
    'CSProtoAddChat',
])
const names = new Set([
    'CSProtoSyncPlayerData',
    'CSProtoPetInfoSync',
    'CSProtoPetEggInfoSync',
    'CSProtoHeroAttrInfoSync',
    'CSProtoObjBattleInfoSync',
    'CSProtoHomeSync',
    'CSProtoTaskSync',
    'CSProtoWorldMapMarkListSync',
    'CSProtoPlayableSync',
])
const nonempty = (value) => Object.keys(value).some((key) => !Array.isArray(value[key]) || value[key].length > 0)
class Delta {
    constructor(cache, force, taskId, forceActive) {
        this.cache = cache
        this.force = force
        this.taskId = taskId
        this.forceActive = forceActive
    }
    bucket(path) {
        let bucket = this.cache.get(path)
        if (!bucket) this.cache.set(path, (bucket = new Map()))
        return bucket
    }
    fields(path, data, keep = []) {
        const bucket = this.bucket(path),
            out = {}
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || (Array.isArray(value) && !value.length)) continue
            const signature = json(value)
            if (this.force || keep.includes(key) || bucket.get(key) !== signature) out[key] = value
            bucket.set(key, signature)
        }
        return out
    }
    activeActor(id) {
        if (!this.forceActive) return false
        const manager = this.cache.get('player.groups.1'),
            groups = this.cache.get('player.groups.1.rows')
        const current = manager?.get('cur_group')
        const raw = current && groups?.get(String(JSON.parse(current)))
        const group = raw && JSON.parse(raw)
        return (
            group?.heros?.some((slot) => String(slot.hero_id) === String(id) || String(slot.pet_id) === String(id)) ??
            false
        )
    }
    rows(path, input = [], key, removed = []) {
        const bucket = this.bucket(path),
            result = []
        for (const id of removed) bucket.delete(String(id))
        for (const row of input) {
            const id = row[key]
            if (id === undefined) {
                result.push(row)
                continue
            }
            const signature = json(row)
            if (
                this.force ||
                (path === 'task.rows' && Number(id) === this.taskId) ||
                (path.startsWith('battle.') && this.activeActor(id)) ||
                bucket.get(String(id)) !== signature
            )
                result.push(row)
            bucket.set(String(id), signature)
        }
        // Eviction causes a later full row resend, never loss of state.
        while (bucket.size > 4096) bucket.delete(bucket.keys().next().value)
        return result
    }
    groups(input = []) {
        const result = []
        for (const manager of input) {
            const { groups = [], src, ...scalar } = manager,
                path = 'player.groups.' + manager.type
            const delta = this.fields(path, scalar),
                rows = this.rows(path + '.rows', groups, 'id')
            delete delta.type
            if (this.force || rows.length || nonempty(delta)) {
                // Populate enumerates groups unconditionally. Keep the active
                // group's complete slots when only manager metadata changed.
                const anchor = groups.find((g) => g.id === manager.cur_group) ?? groups[0]
                result.push({
                    ...delta,
                    type: manager.type,
                    ...(manager.cur_group !== undefined ? { cur_group: manager.cur_group } : {}),
                    ...(manager.src !== undefined ? { src: manager.src } : {}),
                    groups: rows.length ? rows : anchor ? [anchor] : [],
                })
            }
        }
        return result
    }
    player(input) {
        const { basic_info, attr_infos, heros_info, group_mgrs, ...other } = input
        const out = this.fields('player.other', other)
        if (basic_info) {
            const b = this.fields('player.basic', basic_info)
            if (nonempty(b)) out.basic_info = b
        }
        if (attr_infos) {
            const { attrs = [], ...extra } = attr_infos,
                rows = this.rows('player.attrs', attrs, 'attr_id'),
                value = { ...this.fields('player.attrs.extra', extra), attrs: rows }
            if (nonempty(value)) out.attr_infos = value
        }
        if (heros_info) {
            const { heros = [], battle_infos = [], ...extra } = heros_info
            const h = this.rows('player.heros', heros, 'guid'),
                b = this.rows('player.heroBattle', battle_infos, 'hero_id')
            const value = { ...this.fields('player.heros.extra', extra), heros: h, battle_infos: b }
            if (nonempty(value)) {
                // HeroManager also enumerates base heroes unconditionally.
                if (!h.length && heros.length) value.heros = [heros[0]]
                out.heros_info = value
            }
        }
        if (group_mgrs) {
            const groups = this.groups(group_mgrs)
            if (groups.length) out.group_mgrs = groups
        }
        return out
    }
    bag(name, input, field, rowsField) {
        const { [field]: bag, ...other } = input,
            out = this.fields(name + '.meta', other)
        if (bag) {
            const { [rowsField]: rows = [], guid = [], ...extra } = bag
            const value = {
                ...this.fields(name + '.bagMeta', extra),
                [rowsField]: this.rows(name + '.rows', rows, 'guid', guid),
                ...(guid.length ? { guid } : {}),
            }
            if (guid.length) Object.assign(out, other)
            if (nonempty(value)) out[field] = value
        }
        return out
    }
    home(input) {
        const { home_builds = [], del_builds = [], ...other } = input
        const fields = this.fields('home.fields', other),
            builds = this.rows('home.builds', home_builds, 'guid', del_builds)
        if (!this.force && !nonempty(fields) && !builds.length && !del_builds.length) return {}
        // Home receivers have cross-field guards. Keep untouched non-building
        // subsystems until their inner Lua merge semantics are verified.
        const out = { ...other }
        if (builds.length) out.home_builds = builds
        if (del_builds.length) out.del_builds = del_builds
        if (out.home_hub && !builds.length && home_builds.length) out.home_builds = [home_builds[0]]
        return out
    }
    task(input) {
        const { tasks = [], task_records = [], del_tasks = [], del_task_records = [], ...other } = input
        const out = this.fields('task.fields', other, [
            'trace_id',
            'trace_list',
            'new_task_ids',
            'next_main_id',
            'del_trace_list',
            'del_task_items',
        ])
        const rows = this.rows('task.rows', tasks, 'task_id', del_tasks),
            records = this.rows('task.records', task_records, 'task_id', del_task_records)
        if (rows.length) out.tasks = rows
        if (records.length) out.task_records = records
        if (del_tasks.length) out.del_tasks = del_tasks
        if (del_task_records.length) out.del_task_records = del_task_records
        return out
    }
    mark(input) {
        const { marks = [], del_mark_list = [], ...other } = input
        const out = this.fields('mark.fields', other),
            rows = this.rows('mark.rows', marks, 'guid', del_mark_list)
        if (rows.length) out.marks = rows
        if (del_mark_list.length) out.del_mark_list = del_mark_list
        return out
    }
    playable(input) {
        const { plays = [], finish = [], finish_plays = [], del_finish_plays = [], ...other } = input
        const out = this.fields('playable.fields', other)
        const rows = this.rows('playable.rows', plays, 'play_id'),
            finished = this.rows('playable.finish', finish, 'play_id', del_finish_plays)
        const ids = this.bucket('playable.ids'),
            added = []
        for (const id of del_finish_plays) ids.delete(String(id))
        for (const id of finish_plays) {
            if (this.force || !ids.has(String(id))) added.push(id)
            ids.set(String(id), true)
        }
        if (rows.length) out.plays = rows
        if (finished.length) out.finish = finished
        if (added.length) out.finish_plays = added
        if (del_finish_plays.length) out.del_finish_plays = del_finish_plays
        if (nonempty(out)) out.all_sync = input.all_sync ?? false
        return out
    }
    apply(name, input) {
        if (name === 'CSProtoSyncPlayerData') return this.player(input)
        if (name === 'CSProtoPetInfoSync') return this.bag(name, input, 'pet_infos', 'pets')
        if (name === 'CSProtoPetEggInfoSync') return this.bag(name, input, 'egg_infos', 'eggs')
        if (name === 'CSProtoHeroAttrInfoSync') return { heros: this.rows('battle.attrs', input.heros, 'hero_guid') }
        if (name === 'CSProtoObjBattleInfoSync')
            return { ...input, infos: this.rows('battle.infos', input.infos, 'uuid') }
        if (name === 'CSProtoHomeSync') return this.home(input)
        if (name === 'CSProtoTaskSync') return this.task(input)
        if (name === 'CSProtoWorldMapMarkListSync') return this.mark(input)
        if (name === 'CSProtoPlayableSync') return this.playable(input)
        return input
    }
}
// Read only the command tag; decoding a whole scene just to find its command
// needlessly materializes all world objects during an already expensive load.
function sceneCommand(protocol, packet) {
    const field = protocol.type(protocol.byId.get(packet.id).rsp).fields.cmd?.id
    const bytes = packet.payload
    let offset = 0
    const uint = () => {
        let value = 0,
            shift = 0,
            byte
        do {
            byte = bytes[offset++]
            if (shift < 32) value += (byte & 127) * 2 ** shift
            shift += 7
        } while (byte & 128)
        return value
    }
    while (offset < bytes.length) {
        const tag = uint(),
            wire = tag & 7
        if (tag >>> 3 === field && wire === 0) return uint()
        if (wire === 0) uint()
        else if (wire === 1) offset += 8
        else if (wire === 2) {
            const length = uint()
            offset += length
        } else if (wire === 5) offset += 4
        else return null
    }
    return null
}
export function optimizeSyncPackets(protocol, session, packets, requestName = '', taskId) {
    // Called after the state transaction succeeded, in actual send order. Do
    // not deduplicate in packet() creation order (pushBefore can reorder it).
    const decoded = new Map()
    const read = (packet) => {
        if (!decoded.has(packet)) decoded.set(packet, protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload))
        return decoded.get(packet)
    }
    const scene = packets.some(
        (p) => protocol.byId.get(p.id)?.name === 'CSProtoWorldMapSync' && [256, 49].includes(sceneCommand(protocol, p)),
    )
    const allPlay = packets.some((p) => protocol.byId.get(p.id)?.name === 'CSProtoPlayableSync' && read(p).all_sync)
    const force = forceRequests.has(requestName) || scene || allPlay
    const login = ['CSProtoEnterGame', 'CSProtoRenterGame', 'CSProtoCreatePlayer'].includes(requestName)
    const cache = login ? new Map() : (session.syncCache ?? new Map()),
        delta = new Delta(
            cache,
            force,
            taskId,
            ['CSProtoQuickChangeGroupInfo', 'CSProtoSwitchWorldGroup', 'CSProtoWearPet'].includes(requestName),
        ),
        result = []
    if (scene || allPlay)
        for (const key of cache.keys()) {
            if (key.startsWith('playable.') || (scene && key.startsWith('battle.'))) cache.delete(key)
        }
    for (const packet of packets) {
        const name = protocol.byId.get(packet.id)?.name
        if (packet.audience || (packet.recipient && packet.recipient !== session.id)) {
            result.push(packet)
            continue
        }
        if (['CSProtoEnterGame', 'CSProtoRenterGame', 'CSProtoCreatePlayer'].includes(name)) {
            const data = read(packet).data
            if (data) delta.player(data)
            result.push(packet)
            continue
        }
        if (!names.has(name)) {
            result.push(packet)
            continue
        }
        const input = read(packet),
            output = delta.apply(name, input)
        // Combat events already contain only changed UUIDs; keep their event
        // semantics while updating the cache without copying the whole map.
        const keep = force || (name === 'CSProtoObjBattleInfoSync' && requestName === 'CSProtoBattleInfoReduce')
        if (keep) result.push(packet)
        else if (nonempty(output))
            result.push({ ...packet, payload: protocol.encode(protocol.byId.get(packet.id).rsp, output) })
    }
    session.syncCache = cache
    return result
}
