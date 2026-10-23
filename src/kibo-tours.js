import table from '../configs/kibo-tour-tables.json' with { type: 'json' }
import defaults from '../configs/kibo-tour-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime } from './shops.js'
import { parseRewards } from './rewards.js'
import { petInKiboTour } from './kibo-tour-ledger.js'

const uint = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const guid = value => {
    const text = String(value)
    ensure(/^[1-9]\d*$/.test(text) && BigInt(text) <= 0xffffffffffffffffn,
        'Invalid tour pet identity', ErrorCode.ActivityTourPetsDataError)
    return String(BigInt(text))
}

export class KiboTourSystem {
    constructor(tables, activityRows, options = undefined) {
        this.tables = tables
        this.activityRows = activityRows
        this.policy = { ...defaults, ...options }
        const p = this.policy
        ensure(p.schema_version === 1 && p.activityBinding === 'unique_type80_all_catalog_rows' &&
            p.totalQuotaConsumption === 'reward_only' && p.cancelConsumesQuota === false &&
            p.lateSettlement === 'existing_runs_only' && p.petExperience === 'client_element_match_preview' &&
            ['local_complete_lifecycle', 'closed'].includes(p.mode), 'Invalid local tour policy', ErrorCode.GameConfig)
        ensure(uint(p.durationSeconds) && p.durationSeconds > 0, 'Invalid local tour duration', ErrorCode.GameConfig)
        this.claimDisplayEnd = configTime(p.claimDisplayEndTime)
        ensure(Number.isSafeInteger(this.claimDisplayEnd) && this.claimDisplayEnd > 0,
            'Invalid local tour display end', ErrorCode.GameConfig)
        ensure(table.schema_version === 1 && Array.isArray(table.rows), 'Invalid current tour table', ErrorCode.GameConfig)
        this.rows = new Map()
        for (const row of table.rows) {
            ensure(uint(row.id) && row.id > 0 && !this.rows.has(row.id) && uint(row.groupId) && row.groupId > 0,
                'Invalid current tour row identity', ErrorCode.GameConfig)
            const elements = String(row.element).split('|').map(Number)
            ensure(elements.length > 0 && elements.every(n => uint(n) && n > 0) && new Set(elements).size === elements.length,
                'Invalid tour element configuration', ErrorCode.GameConfig)
            const rewards = parseRewards(row.reward)
            ensure(rewards.length > 0, 'Tour has no configured rewards', ErrorCode.ActivityInvalidTourConf)
            this.rows.set(row.id, { ...row, elements, rewards })
        }
        this.totalLimit = this.setting('GAME_EVENT_KIBO_TOUR_TOTAL_NUM')
        this.concurrentLimit = this.setting('GAME_EVENT_KIBO_TOUR_SAME_TIME_NUM')
        this.baseExperience = this.setting('GAME_EVENT_KIBO_TOUR_KIBO_EXP')
        this.experienceIncrease = this.setting('GAME_EVENT_KIBO_TOUR_KIBO_EXP_INCREASE')
        ensure(this.totalLimit > 0 && this.concurrentLimit > 0 && this.concurrentLimit <= this.totalLimit,
            'Invalid tour quotas', ErrorCode.GameConfig)
    }
    setting(title) {
        const rows = this.tables.get('game').filter(r => r.title === title), value = Number(rows[0]?.value)
        ensure(rows.length === 1 && uint(value), `Invalid game setting ${title}`, ErrorCode.GameConfig)
        return value
    }
    requireActivity(row) {
        const rows = this.activityRows.filter(r => r.type === 80)
        ensure(rows.length === 1 && rows[0].id === row.id, 'Ambiguous tour activity catalogue binding', ErrorCode.FunctionClosed)
        // A server-controlled common-time ID is global within this account's UI.
        // Do not extend an ID also referenced by a different activity.
        ensure(row.timelimit > 0 && this.activityRows.filter(r => r.timelimit === row.timelimit).length === 1,
            'Tour activity shares a display time identity', ErrorCode.FunctionClosed)
    }
    entry(entry) {
        const l = (entry.kiboTour ??= { version: 1, next_attempt: 1, total_times: 0, runs: {}, receipts: {} })
        ensure(l.version === 1 && Number.isSafeInteger(l.next_attempt) && l.next_attempt > 0 &&
            uint(l.total_times) && l.runs && typeof l.runs === 'object' && !Array.isArray(l.runs) &&
            l.receipts && typeof l.receipts === 'object' && !Array.isArray(l.receipts),
            'Saved tour ledger is malformed', ErrorCode.GameConfig)
        for (const [key, run] of Object.entries(l.runs)) this.validateRun(run, key)
        return l
    }
    validateRun(run, key = run?.tour_id) {
        ensure(run && uint(run.tour_id) && run.tour_id > 0 && Number.isSafeInteger(run.attempt_id) && run.attempt_id > 0 &&
            [0, 1].includes(run.state) && Number.isSafeInteger(run.start_time) && Number.isSafeInteger(run.end_time) &&
            run.start_time >= 0 && run.end_time > run.start_time && Array.isArray(run.pet_ids) &&
            run.pet_ids.length > 0 && run.pet_ids.length <= 6 && new Set(run.pet_ids).size === run.pet_ids.length,
            'Saved tour run is malformed', ErrorCode.GameConfig)
        ensure(String(key) === String(run.tour_id), 'Saved tour key and run identity differ', ErrorCode.GameConfig)
        for (const id of run.pet_ids) guid(id)
        return run
    }
    hasRuns(entry) {
        return Object.values(entry?.kiboTour?.runs ?? {}).some(r => r?.state === 0 || r?.state === 1)
    }
    due(state, now) {
        return Object.values(state.activities ?? {}).some(e =>
            Object.values(e.kiboTour?.runs ?? {}).some(r => r.state === 0 && now >= r.end_time))
    }
    snapshot(entry, row, now) {
        this.requireActivity(row)
        const ledger = this.entry(entry)
        const runs = Object.values(ledger.runs).map(run => this.validateRun(run))
        for (const run of runs) if (run.state === 0 && now >= run.end_time) run.state = 1
        return {
            total_times: ledger.total_times,
            tour_data: runs.map(run => ({ tour_id: run.tour_id, start_time: String(run.start_time),
                end_time: String(run.end_time), state: run.state, pet_ids: run.pet_ids })),
        }
    }
    presentationWindow(base, state, row) {
        if (row.type !== 80 || !this.hasRuns(state?.activities?.[row.id])) return { ...base }
        this.requireActivity(row)
        return { ...base, end_time: Math.max(base.end_time, this.claimDisplayEnd) }
    }
    start(state, entry, row, request, now, hardWindow) {
        this.requireActivity(row)
        ensure(this.policy.mode !== 'closed', 'Local Kibo tour compatibility is closed', ErrorCode.FunctionClosed)
        ensure(Number.isSafeInteger(now) && now >= 0 && now >= hardWindow.start_time && now <= hardWindow.end_time,
            'Tour activity is outside its original window', ErrorCode.ActivityTimeLimit)
        const config = this.rows.get(request.tour_id)
        ensure(config, 'Tour does not exist in the current catalogue', ErrorCode.ActivityInvalidTourConf)
        const list = request.pet_id_list ?? []
        ensure(Array.isArray(list), 'Invalid tour pet list', ErrorCode.ActivityTourPetsDataError)
        ensure(list.length > 0, 'Kibo tour has no pets', ErrorCode.ActivityTourNonePets)
        ensure(list.length <= 6, 'Kibo tour has too many pets', ErrorCode.ActivityTourPetsDataError)
        const ids = list.map(guid)
        ensure(new Set(ids).size === ids.length, 'Duplicate tour pet', ErrorCode.ActivityTourPetsDataError)
        const ledger = this.entry(entry), old = ledger.runs[config.id]
        if (old) {
            this.validateRun(old)
            ensure(JSON.stringify(old.pet_ids) === JSON.stringify(ids), 'Another trip is already assigned to this area', ErrorCode.ActivityTourExist)
            return { created: false, run: old }
        }
        ensure(ledger.total_times + Object.keys(ledger.runs).length < this.totalLimit,
            'Kibo tour total limit reached', ErrorCode.ActivityTotalTourLimit)
        ensure(Object.keys(ledger.runs).length < this.concurrentLimit,
            'Kibo tour concurrent limit reached', ErrorCode.ActivityTourLimit)
        const end = now + this.policy.durationSeconds
        ensure(Number.isSafeInteger(end) && end <= this.claimDisplayEnd,
            'Local tour duration exceeds supported display horizon', ErrorCode.FunctionClosed)
        ensure(ledger.next_attempt < Number.MAX_SAFE_INTEGER, 'Tour attempt counter exhausted', ErrorCode.GameConfig)
        ensure(!Object.hasOwn(ledger.receipts, ledger.next_attempt) &&
            !Object.values(ledger.runs).some(run => run.attempt_id === ledger.next_attempt),
            'Tour attempt counter would overwrite an existing receipt', ErrorCode.GameConfig)
        const petExperience = ids.map(id => {
            const pet = state.pets.find(p => String(p.guid) === id)
            ensure(pet && !pet.trial && !pet.trail && pet.type !== 2,
                'Tour pet is not a permanent owned pet', ErrorCode.ActivityTourPetsDataError)
            ensure(!petInKiboTour(state, id) && !pet.tour_state,
                'Pet already belongs to a Kibo tour', ErrorCode.ActivityHavePetAlreadyTour)
            const row = this.tables.find('pet', pet.config_id)
            ensure(row, 'Tour pet configuration missing', ErrorCode.PetConfNotExist)
            const elements = Array.isArray(row.element) ? row.element : String(row.element).split('|').map(Number)
            ensure(elements.every(n => uint(n) && n > 0), 'Pet elements are malformed', ErrorCode.GameConfig)
            const matching = elements.some(e => config.elements.includes(e))
            const xp = matching ? Number((BigInt(this.baseExperience) * (10000n + BigInt(this.experienceIncrease)) + 9999n) / 10000n) : 0
            ensure(uint(xp), 'Tour experience exceeds the supported range', ErrorCode.GameConfig)
            return { pet_id: id, config_id: pet.config_id, matching, gain: xp }
        })
        const run = { attempt_id: ledger.next_attempt++, tour_id: config.id, state: 0, start_time: now, end_time: end,
            pet_ids: ids, pet_experience: petExperience, rewards: structuredClone(config.rewards) }
        ledger.runs[config.id] = run
        for (const id of ids) state.pets.find(p => String(p.guid) === id).tour_state = 1
        state.petRevision = (state.petRevision ?? 0) + 1
        return { created: true, run }
    }
    closeRun(state, ledger, run, status, now) {
        ensure(ledger.runs[run.tour_id] === run, 'Tour closure has no matching active identity', ErrorCode.GameConfig)
        ensure(!Object.hasOwn(ledger.receipts, run.attempt_id),
            'Tour closure would overwrite an existing receipt', ErrorCode.GameConfig)
        const receipt = { attempt_id: run.attempt_id, tour_id: run.tour_id, pet_ids: [...run.pet_ids], status, closed_at: now }
        ledger.receipts[run.attempt_id] = receipt
        ;(ledger.last_receipt ??= {})[run.tour_id] = run.attempt_id
        delete ledger.runs[run.tour_id]
        let changed = false
        for (const id of run.pet_ids) {
            const pet = state.pets.find(p => String(p.guid) === id)
            if (!pet) continue // Cancellation must remain a recovery path for a damaged old trip.
            const value = petInKiboTour(state, id) ? 1 : 0
            if (pet.tour_state !== value) { pet.tour_state = value; changed = true }
        }
        if (changed) state.petRevision = (state.petRevision ?? 0) + 1
        return receipt
    }
    cancel(state, entry, row, request, now) {
        this.requireActivity(row)
        const ledger = this.entry(entry), run = ledger.runs[request.tour_id]
        if (!run) {
            const receipt = ledger.receipts[ledger.last_receipt?.[request.tour_id]]
            ensure(receipt?.status === 'cancelled' && receipt.tour_id === request.tour_id,
                'Kibo tour does not exist', ErrorCode.ActivityTourNotExist)
            return false
        }
        this.validateRun(run)
        this.closeRun(state, ledger, run, 'cancelled', now)
        return true
    }
}
