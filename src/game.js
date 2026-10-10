import { repairSavedElevatorVisibility } from './handlers/world-elevator.js'
import { hiddenTaskPetGuids, taskPetPresentation } from './task-pet-presentation.js'
import { repairPetCatalog } from './pet-catalog.js'
import { announcementSnapshot } from './announcements.js'
import { optimizeSyncPackets } from './sync-delta.js'
import { registerPetCatch } from './handlers/pet-catch.js'
import { refundPendingCatchCards } from './handlers/pet-catch.js'
import { repairCharacterCreationMarker } from './character-creation.js'
import { reconcileFormationPets } from './formation-pets.js'
import { syncCurrencyMirrors, restoreMissingStamina } from './currency.js'
import {
    registerTrialGroups,
    trialPayload,
    expireTaskTrialGroup,
    restoreMixedTrialGroup,
} from './handlers/trial-groups.js'
import { prepareTaskScenes } from './task-scenes.js'
import { beginSceneTransition } from './scene-transition.js'
import { worldSync } from './handlers/world.js'
import { worldMarkPayload } from './world-marks.js'
import {
    TaskGraphs,
    unlockAutomaticTasks,
    taskSnapshot,
    taskVisibleAtLevel,
    refreshTaskProgress,
    repairMainTaskTrace,
} from './tasks.js'
import { recoverMissingTaskItems, taskItemSnapshot } from './task-items.js'
import { deliveryKey } from './task-delivery.js'
import { recoverFailedSpecialNpcEvents } from './task-event-recovery.js'
import { recoverCachedTaskTimeEvent } from './task-events.js'
import { repairSoulEssenceStars } from './equipment.js'
import {
    registerPlayableLifecycle,
    playableSnapshot,
    recoverInterruptedFlyTravel,
} from './handlers/playable-lifecycle.js'
import { registerPetSkill } from './handlers/pet-skill.js'
import { registerRoulette, roulettePayload } from './handlers/roulette.js'
import { upgradeInventory } from './inventory.js'
import { registerMonthly, monthlyPayload } from './monthly-card.js'
import { registerPlayableSaves } from './handlers/playable-saves.js'
import { registerLocalPayments } from './handlers/local-payments.js'
import { registerChat, chatSnapshots } from './handlers/chat.js'
import { registerPlayableEnemies } from './handlers/playable-enemies.js'
import { registerGM } from './handlers/gm.js'
import { registerWorldEvents } from './handlers/world-events.js'
import { registerEntrust } from './handlers/entrust.js'
import {
    registerStoryCampaign,
    settleStoryCampaignScene,
    recoverStoryCampaignClear,
} from './handlers/story-campaign.js'
import { traceStoryCampaignTask, ensureStoryCampaignScene, storyCampaignSnapshot } from './story-campaign.js'
import {
    entrustInfoSnapshot,
    entrustStarRewardSnapshot,
    ensureEntrustSceneObjects,
    entrustMultiSnapshot,
    entrustMultiBaseSnapshot,
    campaignSnapshot,
    entrustChestSnapshot,
    entrustDamageSnapshot,
} from './entrust.js'
import {
    registerKiboDuel,
    ensureArenaFormationManager,
    repairPendingDuelEntry,
    arenaAttributePayload,
} from './handlers/kibo-duel.js'
import { registerProfileQueries } from './handlers/profile-queries.js'
import { registerWorldObjects, reconcileWorldCollectionFinalDrops } from './handlers/world-objects.js'
import { registerWorldCombat } from './handlers/world-combat.js'
import { registerWorldSearch } from './handlers/world-search.js'
import { recoverInitialDungeonKills } from './task-kills.js'
import { registerAIControl, clientAIReports } from './handlers/ai-control.js'
import { retireCapturedEnemy } from './handlers/world-combat.js'
import { registerEcology } from './handlers/ecology.js'
import { registerMall } from './handlers/mall.js'
import { registerCombat } from './handlers/combat.js'
import { registerClientState } from './handlers/client-state.js'
import { registerRelease } from './handlers/release.js'
import { releaseFields } from './release-ledger.js'
import { registerHatching } from './handlers/hatching.js'
import { registerProduction } from './handlers/production.js'
import { registerSimpleProduction } from './handlers/simple-production.js'
import { refreshProduction, productionDue } from './production.js'
import { retimeProduction } from './production-time.js'
import { simpleProductionDue, settleSimpleProducts, simpleProductSnapshot } from './simple-production.js'
import { registerTechnology } from './handlers/technology.js'
import { registerBuildingPlacement } from './handlers/buildings.js'
import { registerFarming } from './handlers/farming.js'
import { registerFarmWorkers } from './handlers/farm-workers.js'
import { registerProductionWorkers } from './handlers/production-workers.js'
import { registerCanteen } from './handlers/canteen.js'
import { registerCooking } from './handlers/cooking.js'
import { registerHome } from './handlers/home.js'
import {
    ensureHome,
    ensureHomeCanteens,
    ensureHomeFarmHouses,
    homePayload,
    reconcileHomeBuildShortcuts,
    reconcileHomeCropShortcuts,
} from './home.js'
import { restoreLegacyHomeFormation } from './home-formation.js'
import { repairMainHeroType } from './main-hero.js'
import { upgradeEggState } from './eggs.js'
import { registerShops } from './handlers/shops.js'
import { registerItems } from './handlers/items.js'
import { registerStory } from './handlers/story.js'
import { registerTasks } from './handlers/tasks.js'
import { registerProgression } from './handlers/progression.js'
import { syncBattle } from './battle.js'
import { upgradeSkillState } from './skills.js'
import { randomBytes, randomInt } from 'node:crypto'
import { seedPlayer } from './player.js'
import { repairPetProfiles } from './pets.js'
import { mountPayload, repairMountSelection } from './mounts.js'
import { GameError, ensure, textValue } from './handlers/common.js'

import { registerCore } from './handlers/core.js'
import { registerAIHeroes } from './handlers/ai-heroes.js'
import { repairSavedWorldRepairs } from './world-repairs.js'
import { recoverFailedStoryKills } from './story-battle.js'
import { ensureAppearance, clothesSnapshot, heroSkinsSnapshot } from './appearance.js'
import { registerCollection } from './handlers/collection.js'
import { registerWorld, repairLegacyMountState } from './handlers/world.js'
import { registerMail } from './handlers/mail.js'
const deferredTaskProgress = new Set([
    'CSProtoTaskClientBefore',
    'CSProtoTaskClientCondAfter',
    'CSProtoTaskClientAfter',
    'CSProtoMultiTaskClientBefore',
    'CSProtoMultiTaskClientCondAfter',
    'CSProtoMultiTaskClientAfter',
    'CSProtoTaskClientTrace',
])
const deferredMessages = new Set([
    ...deferredTaskProgress,
    'CSProtoBattleInfoReduce',
    'CSProtoSkillStart',
    'CSProtoSkillStop',
    'CSProtoCreateBullet',
    'CSProtoBulletActionChange',
    'CSProtoFightBreak',
    'CSProtoKiboDuelBTTreeRunning',
    'CSProtoSkillEffectDone',
    'CSProtoMonsterSceneChange',
    'CSProtoShieldInfo',
    'CSProtoShieldInfoDel',
    'CSProtoPerfectDefense',
    'CSProtoCombineAttackBegin',
    'CSProtoCombineAttackEnd',
    'CSProtoStateUpdate',
    'CSProtoPlayableStart',
    'CSProtoWorldEventTrigger',
])
// These client deltas have replies, but must not reset the relation graph or
// use ordinary request persistence while combat is running.
const fastCombatReplies = new Set([
    'CSProtoObjHatredIncSync',
    'CSProtoPlayerHatredIncSync',
    'CSProtoHatredResetSync',
    'CSProtoHatredResetToHomeSync',
])
const fastCombatTelemetry = new Set([
    'CSProtoSkillStart',
    'CSProtoSkillStop',
    'CSProtoCreateBullet',
    'CSProtoBulletActionChange',
    'CSProtoFightBreak',
    'CSProtoKiboDuelBTTreeRunning',
    'CSProtoSkillEffectDone',
    'CSProtoMonsterSceneChange',
    'CSProtoShieldInfo',
    'CSProtoShieldInfoDel',
    'CSProtoPerfectDefense',
])
function forkWithoutPets(base) {
    const { pets, ...other } = base
    return { ...structuredClone(other), pets }
}
function forkMovement(base) {
    return { ...base, world: { ...base.world, pos: { ...base.world.pos } } }
}
function forkBattleReport(base) {
    const player = base.player,
        combat = base.combat
            ? {
                  ...base.combat,
                  entities: { ...base.combat.entities },
                  elements: { ...base.combat.elements },
                  bullets: { ...base.combat.bullets },
                  petSp: { ...base.combat.petSp },
                  energyRemainders: { ...base.combat.energyRemainders },
                  energyTrace: base.combat.energyTrace?.slice(),
                  ...(base.combat.nearDeathReports ? { nearDeathReports: base.combat.nearDeathReports.slice() } : {}),
              }
            : undefined
    return {
        ...base,
        combat,
        bossBattleTrace: base.bossBattleTrace?.slice(),
        player: {
            ...player,
            basic_info: structuredClone(player.basic_info),
            attr_infos: structuredClone(player.attr_infos),
            sbag_infos: structuredClone(player.sbag_infos),
            soulessence_infos: structuredClone(player.soulessence_infos),
            heros_info: { ...player.heros_info, battle_infos: structuredClone(player.heros_info.battle_infos) },
        },
        tasks: structuredClone(base.tasks),
        taskEvents: structuredClone(base.taskEvents),
        ...(base.entrust?.run
            ? {
                  entrust: { ...base.entrust, records: { ...base.entrust.records }, run: { ...base.entrust.run } },
              }
            : {}),
        ...(base.storyCampaign
            ? { storyCampaign: { ...base.storyCampaign, completed_scenes: [...base.storyCampaign.completed_scenes] } }
            : {}),
    }
}
function forkFastCombat(base, name, request) {
    const battle = base.combat ? { ...base.combat } : undefined,
        state = { ...base, combat: battle }
    if (name === 'CSProtoSkillStart')
        state.player = {
            ...base.player,
            heros_info: {
                ...base.player.heros_info,
                battle_infos: structuredClone(base.player.heros_info.battle_infos),
            },
        }
    if (!battle || battle.map_id !== base.world.map_id) return state
    // combatState expires bullets on every access, even when the handler itself
    // only touches a skill. Copy the map so a failed request cannot prune live data.
    battle.bullets = { ...battle.bullets }
    if (fastCombatReplies.has(name) && battle.hatred)
        battle.hatred = Object.fromEntries(
            Object.entries(battle.hatred).map(([field, entries]) => [
                field,
                Object.fromEntries(Object.entries(entries).map(([id, info]) => [id, { ...info }])),
            ]),
        )
    if (name === 'CSProtoSkillStart' || name === 'CSProtoSkillStop') battle.skills = { ...battle.skills }
    if (name === 'CSProtoSkillStart') {
        battle.petSp = { ...battle.petSp }
        battle.energyRemainders = { ...battle.energyRemainders }
    }
    if (name === 'CSProtoBulletActionChange')
        for (const action of request.action_info ?? []) {
            const id = String(action.bullet_id ?? '0')
            if (battle.bullets[id]) battle.bullets[id] = { ...battle.bullets[id] }
        }
    if (name === 'CSProtoMonsterSceneChange') battle.monsterScenes = { ...battle.monsterScenes }
    if (name === 'CSProtoFightBreak') battle.breakValues = { ...battle.breakValues }
    if (name === 'CSProtoPerfectDefense') battle.perfectDefenses = { ...battle.perfectDefenses }
    if (name === 'CSProtoSkillEffectDone') battle.skillEffects = { ...battle.skillEffects }
    if (name === 'CSProtoShieldInfo' || name === 'CSProtoShieldInfoDel') battle.shields = { ...battle.shields }
    return state
}
export class Game {
    constructor(
        protocol,
        store,
        tables,
        {
            clock = () => Math.floor(Date.now() / 1000),
            rng = randomInt,
            crcDelay = 0,
            gmEnabled = true,
            offlinePayments = true,
            taskEventDiagnosticsFile = null,
            syncOptimization = true,
        } = {},
    ) {
        this.announcementBaseUrl = 'http://127.0.0.1:20001/'
        this.syncOptimization = syncOptimization
        this.clock = clock
        this.rng = rng
        this.crcDelay = crcDelay
        this.releaseResetHour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
        this.protocol = protocol
        this.store = store
        this.tables = tables
        this.taskEventDiagnosticsFile = taskEventDiagnosticsFile
        this.handlers = new Map()
        const on = (name, handler) => {
            const e = protocol.byName.get(name) || protocol.byName.get(`CSProto${name}`)
            if (!e) throw Error(`Unknown handler ${name}`)
            if (this.handlers.has(e.id)) throw Error(`Duplicate handler ${name}`)
            this.handlers.set(e.id, handler)
        }
        registerTrialGroups(on, tables)
        registerPlayableSaves(on)
        registerRoulette(on)
        registerPetSkill(on)
        registerPetCatch(on)
        registerPlayableLifecycle(on, tables)
        const runGM = registerGM(on, { enabled: gmEnabled })
        registerCore(on)
        on('AnnounceRequest', (c) => announcementSnapshot(this.announcementBaseUrl, c.now))
        registerAIHeroes(on, tables)
        registerMonthly(on, tables)
        registerLocalPayments(on, tables, store, { enabled: offlinePayments })
        registerChat(on, store, { runGM })
        registerPlayableEnemies(on, tables, store)
        registerWorldEvents(on, tables)
        registerKiboDuel(on, tables, protocol)
        registerEntrust(on, tables)
        registerStoryCampaign(on, tables)
        registerProfileQueries(on, tables, store)
        registerWorldObjects(on, tables)
        registerWorldCombat(on)
        registerWorldSearch(on, tables)
        registerAIControl(on)
        registerEcology(on, tables)
        registerMall(on, tables)
        registerCombat(on)
        registerClientState(on)
        registerCollection(on)
        registerWorld(on)
        registerMail(on)
        registerProgression(on)
        const taskHandlers = registerTasks(on, tables)
        this.finishPendingCharacterTask = taskHandlers.finishPendingCharacterTask
        this.recoverCompletedCampaignTasks = taskHandlers.recoverCompletedCampaignTasks
        registerStory(on, tables)
        registerItems(on)
        registerShops(on, tables)
        registerHome(on, tables)
        registerBuildingPlacement(on, tables)
        registerFarming(on, tables)
        registerFarmWorkers(on, tables)
        registerProductionWorkers(on, tables)
        registerCanteen(on, tables)
        registerCooking(on, tables)
        registerTechnology(on, tables)
        registerProduction(on, tables)
        registerSimpleProduction(on, tables)
        registerHatching(on)
        registerRelease(on, tables)
    }
    recoverFailedPetChoice(state, accountId, now) {
        const task = state.tasks.find((t) => t.task_id === 106010),
            node = task?.nodes.find((n) => n.node_id === 151),
            run = state.playableRuns?.[60001]
        const receipt = state.playableChoiceReceipts?.[`106010:${state.taskEpochs?.[106010] ?? 0}:60001`]
        if (
            !node?.client_before ||
            state.playableFinishes?.[60001] ||
            run?.map_id !== 100 ||
            state.world.map_id !== 100 ||
            run.status !== 2 ||
            run.finish_step < this.tables.find('playable', 60001)?.stepMax ||
            !receipt ||
            receipt.pet_guid !== run.selected_pet_guid ||
            receipt.pet_group !== run.selected_pet_group ||
            state.taskPetChoices?.[106010] !== receipt.pet_group ||
            !state.pets.some((p) => p.guid === receipt.pet_guid) ||
            !this.store.hasFailedRequestAfter(accountId, 9404, run.time * 1000)
        )
            return false
        // The old server rejected this exact finish request after both steps and
        // the selected pet had already been committed. Replay the same handlers
        // during login so rewards and task receipts remain once-only.
        const c = {
            id: accountId,
            state,
            now,
            tables: this.tables,
            randomInt: this.rng,
            push: () => {},
            pushBefore: () => {},
        }
        const call = (name, request) => this.handlers.get(this.protocol.byName.get(`CSProto${name}`).id)(c, request)
        call('PlayableFinish', { playId: 60001, score: 0, pos: {} })
        call('TaskClientCondAfter', { task_id: 106010, node_id: 151, indexes: [0] })
        call('TaskClientAfter', { task_id: 106010, node_id: 151 })
        return true
    }
    recoverClosedPetPageAfterChoice(state, accountId) {
        const task = state.tasks.find((t) => t.task_id === 106010),
            group = state.taskPetChoices?.[106010],
            expected = { 52: 181, 55: 182, 56: 183 }[group]
        const node = task?.nodes.find((n) => n.node_id === expected),
            run = state.playableRuns?.[60001],
            finish = state.playableFinishes?.[60001]
        const receipt = state.playableChoiceReceipts?.[`106010:${state.taskEpochs?.[106010] ?? 0}:60001`]
        if (
            !node?.client_before ||
            node.node_values?.[0] > 0 ||
            state.world.map_id !== 100 ||
            !task.finish_nodes.includes(151) ||
            !task.finish_nodes.includes(148) ||
            run?.status !== 3 ||
            finish?.selected_pet_guid !== run.selected_pet_guid ||
            finish?.selected_pet_group !== group ||
            receipt?.pet_guid !== run.selected_pet_guid ||
            receipt?.pet_group !== group ||
            !state.pets.some((p) => p.guid === receipt.pet_guid) ||
            !this.store.hasFailedRequestAfter(accountId, 9404, run.time * 1000)
        )
            return false
        const key = deliveryKey(state, 106010, expected, 0)
        if (state.taskEvents?.[key]) return false
        // This page-close condition became active only after login repaired a
        // previously rejected PlayableFinish. The old UI is already gone on login;
        // expose the completed condition so the client performs the configured
        // CondAfter/After callbacks and its following story action itself.
        ;(state.taskEvents ??= {})[key] = 1
        return true
    }
    recoverFailedInvestigationPlayable(state, accountId, now) {
        const task = state.tasks.find((t) => t.task_id === 106013),
            node = task?.nodes.find((n) => n.node_id === 6),
            run = state.playableRuns?.[62026]
        if (
            !node?.client_before ||
            node.node_values?.[0] > 0 ||
            state.playableFinishes?.[62026] ||
            state.world.map_id !== 100 ||
            run?.map_id !== 100 ||
            run.status !== 1 ||
            run.finish_step !== 0 ||
            !this.store.hasFailedRequestAfter(accountId, 9406, run.time * 1000) ||
            !this.store.hasFailedRequestAfter(accountId, 9404, run.time * 1000)
        )
            return false
        // The client already completed the five local investigations and sent
        // step 1 followed by Finish. The old zero-step table check rejected
        // both; replay those two handlers once during reconnect.
        const c = {
            id: accountId,
            state,
            now,
            tables: this.tables,
            randomInt: this.rng,
            push: () => {},
            pushBefore: () => {},
        }
        const call = (name, request) => this.handlers.get(this.protocol.byName.get(`CSProto${name}`).id)(c, request)
        call('PlayableStep', { playId: 62026, is_step: true, finish_step: 1 })
        call('PlayableFinish', { playId: 62026, score: 0, pos: {} })
        return true
    }
    packet(id, value = {}, meta = {}) {
        const e = typeof id === 'number' ? this.protocol.byId.get(id) : this.protocol.byName.get(id)
        if (!e?.rsp) throw Error(`No response schema for ${id}`)
        return { id: e.id, payload: this.protocol.encode(e.rsp, value), ...meta }
    }
    dispatch(session, frame) {
        const packets = this.dispatchRaw(session, frame)
        if (!this.syncOptimization) return packets
        const entry = this.protocol.byId.get(frame.id)
        const taskId = ['CSProtoTaskClientCondAfter', 'CSProtoTaskClientAfter', 'CSProtoTaskAccept'].includes(
            entry?.name,
        )
            ? this.protocol.decode(entry.req, frame.payload).task_id
            : undefined
        return optimizeSyncPackets(this.protocol, session, packets, entry?.name, taskId)
    }
    dispatchRaw(session, frame) {
        const e = this.protocol.byId.get(frame.id)
        const now = this.clock()
        if (!e) throw new GameError('Unknown message ID', 1021)
        let r
        try {
            r = this.protocol.decode(e.req, frame.payload)
        } catch {
            throw new GameError('Malformed request', 1022)
        }
        const reply = (v) => this.packet(e.id, v, { seq: frame.seq, pushSeq: frame.pushSeq })
        if (e.name === 'CSProtoPing')
            return [reply({ time_zone: 8, time: now, time_msec: Date.now() % 1000, client_ts: r.client_ts || '0' })]
        if (e.name === 'CSProtoHeartbeat')
            return [
                reply({
                    client_time: r.client_time || {},
                    server_time: { time_zone: 8, time: String(now), time_usec: (Date.now() % 1000) * 1000 },
                }),
            ]
        if (['CSProtoLogin', 'CSProtoEnterGame', 'CSProtoRenterGame'].includes(e.name)) {
            session.entryAttempt = {
                message_id: e.id,
                sequence: frame.seq,
                reconnect: !!r.reconnect,
                has_server_token: !!r.server_token,
            }
            ensure(!session.entered, 'Already entered game')
            ensure(!session.openId || session.openId === r.open_id, 'Account switch requires reconnect')
            const a = this.store.login(r.open_id, (id, openId) => seedPlayer(this.tables, id, openId))
            session.id = a.id
            session.openId = r.open_id
            session.token = session.token || randomBytes(24).toString('hex')
            if (e.name === 'CSProtoLogin') {
                session.entered = false
                return [reply({ open_id: r.open_id, pid: a.id, guid: a.id, server_token: session.token })]
            }
            const packets = this.store.transact(session.id, e.id, (state) => {
                const previousMapId = state.world.map_id
                // The login sends the canonical active node. Do not replay a
                // completed node or retain a barrier from the previous client.
                delete state.pendingTaskStorySync
                if (state.storyCampaign) delete state.storyCampaign.task_context_loaded_map
                repairPendingDuelEntry(state)
                unlockAutomaticTasks(this.tables, state, now)
                repairMainTaskTrace(this.tables, state)
                repairCharacterCreationMarker(state)
                restoreLegacyHomeFormation(state)
                repairMainHeroType(this.tables, state)
                ensureArenaFormationManager(state)
                reconcileFormationPets(state)
                upgradeInventory(state)
                reconcileWorldCollectionFinalDrops(this.tables, state)
                repairSavedWorldRepairs(this.tables, state)
                repairSavedElevatorVisibility(this.tables, state)
                repairLegacyMountState(state, this.tables)
                this.recoverFailedPetChoice(state, session.id, now)
                this.recoverClosedPetPageAfterChoice(state, session.id)
                this.recoverFailedInvestigationPlayable(state, session.id, now)
                recoverInterruptedFlyTravel(this.tables, state)
                settleSimpleProducts(this.tables, state, now)
                recoverStoryCampaignClear({ state, tables: this.tables, now, pushBefore: () => {} })
                recoverFailedSpecialNpcEvents(
                    { state, tables: this.tables, id: session.id, now },
                    this.protocol,
                    this.taskEventDiagnosticsFile,
                )
                recoverCachedTaskTimeEvent({ state, tables: this.tables, id: session.id, now })
                recoverFailedStoryKills(
                    { state, tables: this.tables, id: session.id, now },
                    this.protocol,
                    this.taskEventDiagnosticsFile,
                    this.handlers.get(10799),
                )
                recoverMissingTaskItems(this.tables, new TaskGraphs(this.tables), state)
                refreshTaskProgress(this.tables, state)
                this.recoverCompletedCampaignTasks({
                    state,
                    tables: this.tables,
                    id: session.id,
                    now,
                    randomInt: this.rng,
                    push: () => {},
                    pushBefore: () => {},
                })
                ensureAppearance(this.tables, state)
                prepareTaskScenes(this.tables, state, { login: true })
                ensureEntrustSceneObjects(this.tables, state, now)
                ensureStoryCampaignScene(this.tables, state, now)
                recoverInitialDungeonKills(this.tables, state)
                refreshTaskProgress(this.tables, state)
                beginSceneTransition(state, previousMapId, now, 256)
                traceStoryCampaignTask(state)
                if (state.storyCampaign)
                    settleStoryCampaignScene({ state, tables: this.tables, id: session.id, now, push: () => {} })
                expireTaskTrialGroup(this.tables, state)
                restoreMixedTrialGroup(this.tables, state)
                repairSoulEssenceStars(state)
                refundPendingCatchCards(state)
                syncCurrencyMirrors(state.player)
                restoreMissingStamina(this.tables, state)
                repairPetProfiles(this.tables, state, now)
                repairPetCatalog(this.tables, state)
                repairMountSelection(this.tables, state)
                upgradeSkillState(this.tables, state)
                upgradeEggState(state)
                ensureHome(this.tables, state)
                ensureHomeCanteens(this.tables, state)
                ensureHomeFarmHouses(this.tables, state)
                reconcileHomeBuildShortcuts(this.tables, state)
                reconcileHomeCropShortcuts(this.tables, state)
                retimeProduction(this.tables, state, now)
                refreshProduction(state, now)
                for (const [id, capture] of Object.entries(state.petCaptureResults ?? {}))
                    if (capture.map_id === state.world.map_id && state.combat?.entities?.[id]?.captured !== true)
                        retireCapturedEnemy({ state, now, pushBefore: () => {} }, id)
                const battle = []
                syncBattle({ state, tables: this.tables, push: (name, value) => battle.push(this.packet(name, value)) })
                return [...this.loginPackets(state, session, r, frame, e.id), ...battle]
            })
            session.entered = true
            const activeState = this.store.load(session.id).state,
                campaign = activeState.multiCampaign
            if (campaign?.arena_status) {
                const { duel_id, arena_status, ...wire } = campaign
                const hero = activeState.player.heros_info.heros.find(
                    (h) => h.guid === activeState.kiboDuelGroups?.[0]?.hero,
                )
                const name = Buffer.from(activeState.player.basic_info.name, 'base64').toString('utf8')
                packets.push(
                    this.packet('CSProtoKiboDuelFightingInfoSync', {
                        id: duel_id,
                        status: 2,
                        start_time: Number(wire.start_time),
                    }),
                )
                packets.push(this.packet('CSProtoMultiCampaignInfoSync', { camp: [wire] }))
                packets.push(this.packet('CSProtoCurMultiCampaignInfoSync', wire))
                if (hero) {
                    packets.push(
                        this.packet('CSProtoMultiCampaignBaseInfoSync', {
                            dungeon_id: wire.dungeon_id,
                            dungeon_scene_id: wire.dungeon_scene_id,
                            player_list: [
                                {
                                    player_id: session.id,
                                    hero_id: hero.conf_id,
                                    name,
                                    lv: activeState.player.basic_info.lv,
                                    heros: [{ hero_id: hero.conf_id }],
                                },
                            ],
                            team_option_list: [{ player_id: session.id, stay: true }],
                            player_status_list: [{ player_id: session.id, status: 1 }],
                        }),
                    )
                    packets.push(
                        this.packet('CSProtoKiboDuelArenaPlayerBaseInfo', {
                            infos: [
                                {
                                    player_id: session.id,
                                    name,
                                    player_camp: 1,
                                    hero_guid: hero.guid,
                                    hero_conf_id: hero.conf_id,
                                },
                            ],
                        }),
                    )
                    const formation = activeState.kiboDuelGroups?.[0],
                        guids = formation?.pet_guids?.filter((p) => p.id !== '0').map((p) => p.guid)
                    if (guids?.length && guids.every(Boolean)) {
                        packets.push(
                            this.packet('CSProtoKiboDuelAttrInfoSync', arenaAttributePayload(this.tables, activeState)),
                        )
                        packets.push(this.packet('SCProtoKiboDuelArenaCardInfoSync', { pet_guids: guids }))
                        if (activeState.kiboDuelFirstGuid)
                            packets.push(
                                this.packet('SCProtoKiboDuelArenaFirstInfoSync', {
                                    id: session.id,
                                    pet_guid: activeState.kiboDuelFirstGuid,
                                }),
                            )
                    }
                }
                packets.push(
                    this.packet('SCProtoKiboDuelArenaInfoSync', {
                        status: arena_status,
                        status_endtime: String(now + 300),
                        enter_type: 0,
                    }),
                )
            }
            return packets
        }
        ensure(session.id, 'Login required', 101)
        if (e.name === 'CSProtoCreatePlayer') {
            return this.store.transact(session.id, e.id, (state) => {
                if (r.name) state.player.basic_info.name = textValue(r.name, 15)
                if (r.wardrobe_info) {
                    ensure([1, 2].includes(r.wardrobe_info.sex))
                    state.player.basic_info.wardrobe = r.wardrobe_info
                    state.player.basic_info.sex = r.wardrobe_info.sex
                }
                repairMainHeroType(this.tables, state)
                return this.loginPackets(state, session, r, frame, e.id)
            })
        }
        if (e.name === 'CSProtoLogout' || e.name === 'CSProtoOffline') {
            session.close = true
            return []
        }
        if (e.name === 'CSProtoRecycle') return [reply({})]
        const handler = this.handlers.get(e.id)
        if (!handler) throw new GameError(`Unsupported ${e.name}`, 1021)
        if (e.name === 'CSProtoWorldObjSearch')
            return this.store.read(session.id, (state) => [reply(handler({ state, tables: this.tables }, r))])
        if (e.name === 'CSProtoWorldMapExtraStatus') {
            const response = handler(
                {
                    now,
                    setExtraStatus: (value) => {
                        session.worldExtraStatus = value
                    },
                },
                r,
            )
            return [reply(response)]
        }
        if (clientAIReports.has(e.name)) {
            session.aiControl = handler(
                {
                    id: session.id,
                    tables: this.tables,
                    state: this.store.load(session.id).state,
                    aiControl: session.aiControl,
                },
                r,
            )
            return []
        }
        if (e.name === 'CSProtoMonsterSceneChange' && !(r.infos ?? []).length)
            return this.store.read(session.id, (state) => {
                handler({ state, tables: this.tables, now }, r)
                return []
            })
        if (fastCombatTelemetry.has(e.name) || fastCombatReplies.has(e.name) || e.name === 'CSProtoStateUpdate')
            return this.store.transact(
                session.id,
                e.id,
                (state) => {
                    const before = [],
                        after = []
                    const context = {
                        id: session.id,
                        requestKey: frame.seq ? session.token + ':' + frame.id + ':' + frame.seq : null,
                        state,
                        now,
                        randomInt: this.rng,
                        tables: this.tables,
                        pushBefore: (name, value) => before.push(this.packet(name, value)),
                        push: (name, value) => after.push(this.packet(name, value, { pushSeq: frame.pushSeq })),
                    }
                    const response = handler(context, r)
                    return [...before, ...(fastCombatReplies.has(e.name) ? [reply(response)] : []), ...after]
                },
                {
                    defer: true,
                    fork: (base) =>
                        e.name === 'CSProtoStateUpdate' ? forkMovement(base) : forkFastCombat(base, e.name, r),
                },
            )
        return this.store.transact(
            session.id,
            e.id,
            (state) => {
                const battleReport = e.name === 'CSProtoBattleInfoReduce'
                const saddlesBefore = JSON.stringify(state.mountSaddles)
                const booksBefore = JSON.stringify(state.readingBooks ?? {})
                const basicBefore = JSON.stringify(state.player.basic_info),
                    attrsBefore = JSON.stringify(state.player.attr_infos)
                const essenceBefore = JSON.stringify(state.player.soulessence_infos)
                repairSoulEssenceStars(state)
                const bagBefore = JSON.stringify(state.player.sbag_infos)
                upgradeInventory(state)
                const statePacket = (name, value, meta = {}) => {
                    if (name === 'CSProtoPetInfoSync') value = taskPetPresentation(this.tables, state, value)
                    if (name === 'CSProtoSyncPlayerData' && value) {
                        syncCurrencyMirrors(state.player)
                        const { sbag_infos, soulessence_infos, ...other } = value
                        value = {
                            ...other,
                        }
                        if (!Object.keys(value).length) return null
                    }
                    return this.packet(name, value, meta)
                }
                const emit = (target, name, value, meta) => {
                    const p = statePacket(name, value, meta)
                    if (p) target.push(p)
                }
                const petIdsBefore = state.pets.map((p) => p.guid)
                const eggIdsBefore = (state.petEggs || []).map((e) => e.guid)
                const ornamentIdsBefore = (state.ornaments || []).map((entry) => entry.guid)
                const petRevision = state.petRevision || 0
                const petViewBefore = battleReport ? null : hiddenTaskPetGuids(this.tables, state).join(',')
                const playerLevelBefore = state.player.basic_info.lv
                const taskItemRevision = state.taskItemRevision ?? 0
                const homeBuildIdsBefore = (state.home?.builds || []).map((b) => b.guid)
                const homeWishIdsBefore = (state.home?.wishlist || []).map((x) => x.uid)
                const homeRevision = state.homeRevision || 0
                const eggRevision = state.eggRevision || 0
                const ornamentRevision = state.ornamentRevision || 0
                const before = []
                const pushes = []
                const context = {
                    id: session.id,
                    previousMapId: state.world.map_id,
                    combatSessionId: session.token,
                    requestKey: frame.seq ? session.token + ':' + frame.id + ':' + frame.seq : null,
                    state,
                    now,
                    randomInt: this.rng,
                    tables: this.tables,
                    pushTo: (recipient, name, value) => pushes.push(this.packet(name, value, { recipient })),
                    broadcast: (audience, name, value) => pushes.push(this.packet(name, value, { audience })),
                    pushBefore: (name, value) => emit(before, name, value),
                    push: (name, value) => emit(pushes, name, value, { pushSeq: frame.pushSeq }),
                }
                if (!battleReport) {
                    retimeProduction(this.tables, state, now)
                    refreshProduction(state, now)
                }
                // Older servers persisted the selected pet and final step, then rejected
                // PlayableFinish. The client keeps requesting Start while that run remains
                // incomplete, so recover on the next request as well as on login.
                const recoveredChoice =
                    e.name === 'CSProtoPlayableStart' &&
                    r.u32 === 60001 &&
                    this.recoverFailedPetChoice(state, session.id, now)
                if (recoveredChoice) {
                    context.push('CSProtoPlayableSync', playableSnapshot(state))
                    context.push('CSProtoTaskSync', taskSnapshot(this.tables, state))
                }
                const response = recoveredChoice ? {} : handler(context, r)
                if (!battleReport && retimeProduction(this.tables, state, now)) refreshProduction(state, now)
                if (e.name === 'CSProtoPlayerCustomData') this.finishPendingCharacterTask(context)
                if (!battleReport) this.recoverCompletedCampaignTasks(context)
                if ((state.taskItemRevision ?? 0) !== taskItemRevision)
                    context.pushBefore('CSProtoTaskSync', taskItemSnapshot(state))
                syncCurrencyMirrors(state.player)
                const updatedTasks = refreshTaskProgress(this.tables, state)
                const visibleUpdates = updatedTasks.filter(
                    (task) =>
                        taskVisibleAtLevel(this.tables, state, task) &&
                        task.task_id !== state.pendingTaskStorySync?.task_id,
                )
                if (visibleUpdates.length) context.push('CSProtoTaskSync', { tasks: visibleUpdates })
                const levelChanged = state.player.basic_info.lv !== playerLevelBefore
                const newTasks = battleReport && !levelChanged ? [] : unlockAutomaticTasks(this.tables, state, now)
                if (newTasks.length)
                    context.push('CSProtoTaskSync', { ...taskSnapshot(this.tables, state), new_task_ids: newTasks })
                else if (levelChanged) {
                    const newlyVisible = state.tasks
                        .filter(
                            (task) =>
                                taskVisibleAtLevel(this.tables, state, task) &&
                                !taskVisibleAtLevel(
                                    this.tables,
                                    {
                                        ...state,
                                        player: {
                                            ...state.player,
                                            basic_info: { ...state.player.basic_info, lv: playerLevelBefore },
                                        },
                                    },
                                    task,
                                ),
                        )
                        .map((task) => task.task_id)
                    context.push('CSProtoTaskSync', { ...taskSnapshot(this.tables, state), new_task_ids: newlyVisible })
                }
                if (state.home?.technology && state.player.basic_info.lv !== playerLevelBefore)
                    state.homeRevision = (state.homeRevision || 0) + 1
                if (!battleReport && prepareTaskScenes(this.tables, state)) {
                    worldSync({ ...context, push: context.pushBefore })
                    syncBattle({ ...context, push: context.pushBefore })
                }
                if (!battleReport && expireTaskTrialGroup(this.tables, state)) {
                    context.pushBefore('CSProtoTrialDatas', trialPayload(state))
                    context.pushBefore('CSProtoSyncPlayerData', {
                        heros_info: state.player.heros_info,
                        group_mgrs: state.player.group_mgrs,
                    })
                    syncBattle({ ...context, push: context.pushBefore })
                }
                const petSync =
                    (state.petRevision || 0) !== petRevision ||
                    (!battleReport && petViewBefore !== hiddenTaskPetGuids(this.tables, state).join(','))
                        ? [
                              this.packet('CSProtoPetInfoSync', {
                                  ...releaseFields(state, 'pet', now, this.releaseResetHour),
                                  record_pets: state.recordPets ?? [],
                                  pet_infos: taskPetPresentation(this.tables, state, {
                                      pet_infos: {
                                          pets: state.pets,
                                          guid: petIdsBefore.filter((id) => !state.pets.some((p) => p.guid === id)),
                                      },
                                  }).pet_infos,
                              }),
                              this.packet('CSProtoPetBoxInfoSync', { box_infos: state.petBoxes }),
                          ]
                        : []
                if (petSync.length) syncBattle({ ...context, push: context.pushBefore })
                const packets = e.rsp ? [reply(response || {})] : []
                const eggSync =
                    (state.eggRevision || 0) !== eggRevision
                        ? [
                              this.packet('CSProtoPetEggInfoSync', {
                                  ...releaseFields(state, 'egg', now, this.releaseResetHour),
                                  egg_infos: {
                                      eggs: state.petEggs || [],
                                      guid: eggIdsBefore.filter(
                                          (id) => !(state.petEggs || []).some((e) => e.guid === id),
                                      ),
                                  },
                              }),
                          ]
                        : []
                const ornamentSync =
                    (state.ornamentRevision || 0) !== ornamentRevision
                        ? [
                              this.packet('CSProtoUpdateOrnament', {
                                  ornaments: (state.ornaments || []).filter(
                                      (entry) => !ornamentIdsBefore.includes(entry.guid),
                                  ),
                                  guid: ornamentIdsBefore.filter(
                                      (id) => !(state.ornaments || []).some((entry) => entry.guid === id),
                                  ),
                                  smelt_num: state.ornamentSmeltNum || 0,
                              }),
                          ]
                        : []
                const homeSync =
                    (state.homeRevision || 0) !== homeRevision
                        ? [
                              this.packet('CSProtoHomeSync', {
                                  ...homePayload(this.tables, state),
                                  del_builds: homeBuildIdsBefore.filter(
                                      (id) => !state.home.builds.some((b) => b.guid === id),
                                  ),
                                  del_wishlist: homeWishIdsBefore.filter(
                                      (id) => !state.home.wishlist.some((x) => x.uid === id),
                                  ),
                              }),
                          ]
                        : []
                const playerDelta = {}
                if (JSON.stringify(state.player.sbag_infos) !== bagBefore)
                    playerDelta.sbag_infos = state.player.sbag_infos
                if (JSON.stringify(state.player.soulessence_infos) !== essenceBefore)
                    playerDelta.soulessence_infos = state.player.soulessence_infos
                if (JSON.stringify(state.player.basic_info) !== basicBefore)
                    playerDelta.basic_info = state.player.basic_info
                if (JSON.stringify(state.player.attr_infos) !== attrsBefore)
                    playerDelta.attr_infos = state.player.attr_infos
                const playerSync = Object.keys(playerDelta).length
                    ? [this.packet('CSProtoSyncPlayerData', playerDelta)]
                    : []
                const saddleSync =
                    JSON.stringify(state.mountSaddles) !== saddlesBefore
                        ? [this.packet('CSProtoRideMountInfo', { mount_saddlerys: state.mountSaddles })]
                        : []
                const bookSync =
                    JSON.stringify(state.readingBooks ?? {}) !== booksBefore
                        ? [
                              this.packet('CSProtoReadHandbookInfoSync', {
                                  infos: Object.values(state.readingBooks ?? {}),
                                  send_type: 1,
                              }),
                          ]
                        : []
                return [
                    ...playerSync,
                    ...saddleSync,
                    ...bookSync,
                    ...petSync,
                    ...before,
                    ...eggSync,
                    ...ornamentSync,
                    ...homeSync,
                    ...packets,
                    ...pushes,
                ]
            },
            {
                defer: deferredMessages.has(e.name),
                // Pure phase/trace acknowledgments do not require a disk commit.
                // Item actions and newly granted After rewards remain durable.
                logDeferred: deferredTaskProgress.has(e.name),
                persistWhen: deferredTaskProgress.has(e.name)
                    ? (draft, base) => {
                          if ((draft.taskItemRevision ?? 0) !== (base.taskItemRevision ?? 0)) return true
                          // Also cover another task completed by the normal recovery pass.
                          return Object.entries(draft.taskAfterReceipts ?? {}).some(
                              ([key, rewards]) => !base.taskAfterReceipts?.[key] && rewards.length > 0,
                          )
                      }
                    : undefined,
                fork:
                    e.name === 'CSProtoBattleInfoReduce'
                        ? forkBattleReport
                        : deferredMessages.has(e.name)
                          ? forkWithoutPets
                          : undefined,
            },
        )
    }
    tick(id, session) {
        const packets = this.tickRaw(id)
        return this.syncOptimization && session ? optimizeSyncPackets(this.protocol, session, packets, 'tick') : packets
    }
    tickRaw(id) {
        const now = this.clock(),
            current = this.store.load(id).state,
            homeDue = productionDue(current, now),
            simpleDue = simpleProductionDue(current, now)
        if (!homeDue && !simpleDue) return []
        return this.store.transact(id, 0, (state) => {
            const packets = [],
                eggRevision = state.eggRevision || 0,
                petRevision = state.petRevision || 0
            if (homeDue && refreshProduction(state, now)) {
                if ((state.eggRevision || 0) !== eggRevision)
                    packets.push(
                        this.packet('CSProtoPetEggInfoSync', {
                            ...releaseFields(state, 'egg', now, this.releaseResetHour),
                            egg_infos: { eggs: state.petEggs || [] },
                        }),
                    )
                packets.push(this.packet('CSProtoHomeSync', homePayload(this.tables, state)))
                if ((state.petRevision || 0) !== petRevision)
                    packets.push(
                        this.packet('CSProtoPetInfoSync', {
                            ...releaseFields(state, 'pet', now, this.releaseResetHour),
                            record_pets: state.recordPets ?? [],
                            pet_infos: taskPetPresentation(this.tables, state, { pet_infos: { pets: state.pets } })
                                .pet_infos,
                        }),
                    )
            }
            if (simpleDue) {
                const settled = settleSimpleProducts(this.tables, state, now)
                if (settled.changed) {
                    if (settled.rewards.length)
                        packets.push(
                            this.packet('CSProtoSyncPlayerData', {
                                sbag_infos: state.player.sbag_infos,
                                basic_info: state.player.basic_info,
                                attr_infos: state.player.attr_infos,
                            }),
                        )
                    packets.push(
                        this.packet('CSProtoSimpleProductFinish', {
                            ...simpleProductSnapshot(state),
                            reward: { rewards: settled.rewards },
                            dels: settled.dels,
                        }),
                    )
                    const updated = refreshTaskProgress(this.tables, state)
                    const visible = updated.filter(
                        (task) =>
                            taskVisibleAtLevel(this.tables, state, task) &&
                            task.task_id !== state.pendingTaskStorySync?.task_id,
                    )
                    if (visible.length) packets.push(this.packet('CSProtoTaskSync', { tasks: visible }))
                }
            }
            return packets
        })
    }
    loginPackets(state, session, r, frame, id) {
        const now = this.clock()
        return [
            this.packet('CSProtoEnterGameCallbackStart', {
                reconnect: !!r.reconnect,
                player_id: session.id,
                crc_rand_index: this.crcDelay,
                server_time: String(Date.now()),
                time_offset: '0',
            }),
            this.packet(
                id,
                {
                    data: state.player,
                    reconnect: !!r.reconnect,
                    time_zone: 8,
                    time: now,
                    time_msec: Date.now() % 1000,
                    player_id: session.id,
                    server_token: session.token,
                    rc4_key: '',
                    ntf_seq: r.ntf_seq || 0,
                    req_seq: frame.seq,
                    line_id: 0,
                    server_id: 'LurukaPS',
                    node_id: 'lurukaps-0',
                },
                { seq: frame.seq, pushSeq: frame.pushSeq },
            ),
            ...(state.trialGroup ? [this.packet('CSProtoTrialDatas', trialPayload(state))] : []),
            this.packet('CSProtoPetInfoSync', {
                ...releaseFields(state, 'pet', now, this.releaseResetHour),
                record_pets: state.recordPets ?? [],
                pet_infos: taskPetPresentation(this.tables, state, { pet_infos: { pets: state.pets } }).pet_infos,
            }),
            this.packet('CSProtoPetEggInfoSync', {
                ...releaseFields(state, 'egg', now, this.releaseResetHour),
                egg_infos: { eggs: state.petEggs || [] },
            }),
            this.packet('CSProtoPetBoxInfoSync', { box_infos: state.petBoxes }),
            this.packet('SCProtoClothesInfoSync', clothesSnapshot(this.tables, state)),
            this.packet('SCProtoPresetWardrobeSync', { info_list: state.wardrobePresets ?? [] }),
            this.packet('SCProtoHeroSkinMessageSync', heroSkinsSnapshot(this.tables, state)),
            this.packet('CSProtoAllEquipOrnamentSync', {
                ornaments: state.ornaments || [],
                smelt_num: state.ornamentSmeltNum || 0,
            }),
            this.packet('CSProtoRideMountInfo', mountPayload(this.tables, state)),
            this.packet('CSProtoEntrustInfoSync', entrustInfoSnapshot(state)),
            this.packet('CSProtoEntrustStarRewardSync', entrustStarRewardSnapshot(state)),
            ...(state.entrust?.run?.map_id === state.world.map_id
                ? [
                      ...(this.tables.find('world_city', state.world.map_id)?.type === 2
                          ? [
                                this.packet('CSProtoCurMultiCampaignInfoSync', {
                                    status: 1,
                                    dungeon_id: state.entrust.run.dungeon_id,
                                }),
                                this.packet('CSProtoCampaignInfoSync', campaignSnapshot(state.entrust.run)),
                            ]
                          : [
                                this.packet(
                                    'CSProtoMultiCampaignBaseInfoSync',
                                    entrustMultiBaseSnapshot(state, session.id),
                                ),
                                this.packet('CSProtoMultiCampaignInfoSync', {
                                    camp: [entrustMultiSnapshot(state.entrust.run)],
                                }),
                                this.packet('CSProtoCurMultiCampaignInfoSync', entrustMultiSnapshot(state.entrust.run)),
                            ]),
                      this.packet('SCProtoMultiCampaignPlayerDmgInfoSync', entrustDamageSnapshot(state, session.id)),
                      this.packet('CSProtoStaminaBoxSync', entrustChestSnapshot(this.tables, state)),
                  ]
                : []),
            ...(state.storyCampaign?.map_id === state.world.map_id
                ? [this.packet('CSProtoCampaignInfoSync', storyCampaignSnapshot(state))]
                : []),
            this.packet('CSProtoTaskSync', taskSnapshot(this.tables, state)),
            this.packet('CSProtoMailSync', { mails: state.mail }),
            this.packet('CSProtoStorySync', { infos: { infos: state.storyIds || [] } }),
            this.packet('CSProtoHomeSync', homePayload(this.tables, state)),
            this.packet('CSProtoSimpleProductFinish', simpleProductSnapshot(state)),
            this.packet('SCProtoMonthlyCardInfoSync', monthlyPayload(state)),
            this.packet('CSProtoReadHandbookInfoSync', {
                infos: Object.values(state.readingBooks ?? {}),
                send_type: 0,
            }),
            this.packet('CSProtoPlayableSync', playableSnapshot(state)),
            this.packet('CSProtoAllRouletteInfoSync', roulettePayload(state)),
            this.packet('CSProtoWorldMapMarkListSync', worldMarkPayload(state)),
            this.packet('CSProtoAnnouncementNotify', announcementSnapshot(this.announcementBaseUrl, now)),
            this.packet('CSProtoChatRoomSync', { chat_type: 2, sysId: String(state.chatWorldRoom ?? 1) }),
            this.packet('CSProtoChatListSync', chatSnapshots(this.store, state, session.id).list),
            this.packet('CSProtoChatMsgCntSync', chatSnapshots(this.store, state, session.id).counts),
        ]
    }
}
