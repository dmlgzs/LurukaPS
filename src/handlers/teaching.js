import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { teachingConfig } from '../teaching.js'
import { ensureStoryCampaignScene, storyCampaignSnapshot } from '../story-campaign.js'
import { worldSync } from './world.js'
import { syncBattle } from '../battle.js'
import { syncStoryCampaignEnemies } from './story-campaign.js'

export function registerTeaching(on, tables) {
    on('TeachStart', (c, r) => {
        const train = tables.get('train_task').find((row) => row.taskid === r.id)
        ensure(train, 'Unknown teaching task', ErrorCode.TrainTaskConfNone)
        // groupType is the UI's battle/hero/duel category; taskType has a
        // different numbering. Keep the existing KiboDuelStart path separate.
        ensure([1, 2].includes(train.groupType), 'Unsupported teaching task type', ErrorCode.TeachTypeNotExit)
        ensure(!c.state.storyCampaign?.teaching_id, 'Another teaching task is active', ErrorCode.IsTeaching)
        ensure(
            !c.state.storyCampaign && !c.state.entrust?.run && !c.state.cultTrial && !c.state.multiCampaign,
            'Another dungeon is active',
            ErrorCode.InvalidLogic,
        )
        const parts = String(train.unlockCondition).split('#').map(Number)
        const [kind, level] = parts
        ensure(
            parts.length === 2 && parts.every(Number.isInteger) && level > 0,
            'Invalid teaching unlock condition',
            ErrorCode.GameConfig,
        )
        ensure(kind === 2004, 'Teaching unlock condition type is not supported', ErrorCode.InvalidLogic)
        ensure(c.state.player.basic_info.lv >= level, 'Teaching task is locked', ErrorCode.TeachUnlock)
        const config = teachingConfig(tables, tables.find('dungeon', train.dungeonId))
        if (r.activity_id) {
            ensure(c.activityCatalog, 'Activity catalog unavailable', ErrorCode.GameConfig)
            const activity = c.activityCatalog.rows.find((row) => row.id === r.activity_id)
            ensure(activity, 'Teaching activity configuration unavailable', ErrorCode.NoActivityConf)
            ensure(activity.type === 110, 'Teaching activity type mismatch', ErrorCode.ActivityTypeNotEqual)
            const window = c.activityCatalog.window(activity, c.now)
            ensure(
                c.now >= window.start_time && c.now <= window.end_time,
                'Teaching activity is closed',
                ErrorCode.ActivityNotOpen,
            )
            ensure(c.activityCatalog.unlocked(activity, c.state), 'Teaching activity is locked', ErrorCode.TeachUnlock)
        }
        const w = c.state.world
        const run = (c.state.storyCampaign = {
            dungeon_id: config.dungeon.id,
            group_id: config.dungeon.groupId,
            difficulty: config.dungeon.dungeonGroupOrder,
            instance_id: c.state.nextStoryCampaignInstanceId ?? 1,
            teaching_id: train.taskid,
            teaching_activity: r.activity_id ?? 0,
            scenes: config.scenes.map((x) => x.scene.id),
            map_id: config.scenes[0].scene.id,
            task_ids: [],
            completed_scenes: [],
            stage_index: 0,
            status: 2,
            start_time: c.now,
            return_world: {
                map_id: w.map_id,
                point_id: w.point_id,
                area_id: w.area_id,
                pos: { ...w.pos },
                angle: w.angle,
            },
        })
        c.state.nextStoryCampaignInstanceId = run.instance_id + 1
        Object.assign(w, tables.position(config.scenes[0].point))
        delete c.state.combat
        ensureStoryCampaignScene(tables, c.state, c.now)
        c.pushBefore('CSProtoTeachInfoSync', { u32s: c.state.teachingRecords ?? [] })
        c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
        worldSync(
            { ...c, push: c.pushBefore },
            { campaign_start: { group_id: run.group_id, difficulty: run.difficulty } },
            256,
            false,
        )
        syncBattle({ ...c, push: c.pushBefore })
        syncStoryCampaignEnemies(c)
        return {}
    })
}
