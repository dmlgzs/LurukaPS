import { purchaseMonthly, monthlyPayload } from '../monthly-card.js'
import { giveAllRewards } from '../give-all.js'
import { ensure, syncPlayer } from './common.js'
import { grantRewards } from '../rewards.js'
import { heroModules, heroBattleLimits, syncBattle } from '../battle.js'
import { rememberMap, worldSync } from './world.js'
import { deliveryKey } from '../task-delivery.js'
import {
    TaskGraphs,
    acceptAvailableSideTasks,
    clearDevelopmentTasks,
    conditionSatisfied,
    conditionTargetValue,
    conditionValue,
    nodeConditions,
    taskSnapshot,
} from '../tasks.js'
const help =
    'help | acceptall [dev] | cleardevtasks | giveall | giveallgifts | item <id> <count> | give <type> <id> <count> | gold <count> | diamond <count> | level <level> | monthcard <count> | heal | tp <birth-point-id> | taskgoal | unlockmaps'
const decoder = new TextDecoder('utf-8', { fatal: true })
function string(value) {
    const bytes = Buffer.from(value ?? '', 'base64')
    ensure(bytes.length <= 512, 'GM argument is too long')
    try {
        return decoder.decode(bytes)
    } catch {
        ensure(false, 'GM command is not UTF-8')
    }
}
function integer(value, max = 1000000) {
    ensure(/^\d+$/.test(value ?? ''), 'Expected positive integer')
    const n = Number(value)
    ensure(Number.isSafeInteger(n) && n > 0 && n <= max, 'GM number outside allowed range')
    return n
}
function currentTask(tables, state) {
    const tasks = state.tasks ?? [],
        main = (t) => tables.find('task', t.task_id)?.type === 1
    return (
        tasks.find((t) => t.client_trace && main(t)) ??
        tasks.find(main) ??
        tasks.find((t) => t.client_trace) ??
        tasks[0]
    )
}
export function registerGM(on, { enabled = true } = {}) {
    let graphs
    const execute = (c, request) => {
        ensure(enabled, 'Local GM commands are disabled')
        const text = string(request.command).trim()
        ensure(text && text.length <= 512, 'Empty GM command')
        const parts = text.split(/\s+/),
            name = parts.shift().toLowerCase(),
            args = [...parts, ...(request.args ?? []).map(string)]
        ensure(args.length <= 8, 'Too many GM arguments')
        let result
        const count = (n) => ensure(args.length === n, 'Usage: ' + help)
        if (name === 'help') {
            count(0)
            result = help
        } else if (name === 'acceptall') {
            ensure(args.length <= 1 && (!args.length || args[0].toLowerCase() === 'dev'), 'Usage: acceptall [dev]')
            graphs ??= new TaskGraphs(c.tables)
            const { added, unavailable } = acceptAvailableSideTasks(c.tables, c.state, c.now, graphs, {
                includeDev: args.length === 1,
            })
            if (added.length) {
                const barrier = c.state.pendingTaskStorySync
                if (barrier) {
                    barrier.extra ??= {}
                    barrier.extra.new_task_ids = [...new Set([...(barrier.extra.new_task_ids ?? []), ...added])]
                } else c.pushBefore('CSProtoTaskSync', { ...taskSnapshot(c.tables, c.state), new_task_ids: added })
            }
            result = 'Accepted ' + added.length + ' available unfinished non-main tasks'
            if (unavailable.length) result += '; unavailable task configuration: ' + unavailable.join(',')
        } else if (name === 'cleardevtasks') {
            count(0)
            const ids = clearDevelopmentTasks(c.tables, c.state)
            if (ids.length) {
                const barrier = c.state.pendingTaskStorySync
                if (barrier) {
                    barrier.extra ??= {}
                    for (const field of ['del_tasks', 'del_trace_list'])
                        barrier.extra[field] = [...new Set([...(barrier.extra[field] ?? []), ...ids])]
                } else
                    c.pushBefore('CSProtoTaskSync', {
                        ...taskSnapshot(c.tables, c.state),
                        del_tasks: ids,
                        del_trace_list: ids,
                    })
            }
            result = 'Removed ' + ids.length + ' active development/test tasks'
        } else if (name === 'giveallgifts') {
            count(0)
            const ids = new Set()
            const items = c.tables.get('common_item').filter((item) => {
                if (ids.has(item.id)) return false
                const gift = item.type === 110 && c.tables.find('hero_favorability_gift', item.id)
                const furniture = item.type === 111 && c.tables.find('home_dorm_furniture', item.id)
                if (!gift && !(furniture && c.tables.find('hero', furniture.heroId))) return false
                ids.add(item.id)
                return true
            })
            ensure(items.length > 0, 'Hero gift catalog is empty', 1007)
            grantRewards(
                c.tables,
                c.state,
                items.map((item) => ({ itemtype: 3, itemid: item.id, itemnum: 999 })),
            )
            syncPlayer({ ...c, push: c.pushBefore })
            result = 'Granted ' + items.length + ' hero gifts x999 each'
        } else if (name === 'giveall') {
            count(0)
            const rewards = giveAllRewards(c.tables, c.state)
            grantRewards(c.tables, c.state, rewards)
            syncPlayer({ ...c, push: c.pushBefore })
            result = `Granted all ${rewards.filter((r) => r.itemtype === 3).length} common items (999 each, nonstackable 1); ensured one of every soul essence`
        } else if (['item', 'additem', 'give', 'gold', 'diamond'].includes(name)) {
            let reward
            if (name === 'give') {
                count(3)
                reward = {
                    itemtype: integer(args[0], 255),
                    itemid: integer(args[1], 0xffffffff),
                    itemnum: integer(args[2]),
                }
            } else if (name === 'item' || name === 'additem') {
                count(2)
                reward = { itemtype: 3, itemid: integer(args[0], 0xffffffff), itemnum: integer(args[1]) }
            } else {
                count(1)
                reward = { itemtype: 10, itemid: name === 'gold' ? 2 : 1, itemnum: integer(args[0]) }
            }
            grantRewards(c.tables, c.state, [reward])
            syncPlayer({ ...c, push: c.pushBefore })
            result = `Granted ${reward.itemtype}:${reward.itemid} x${reward.itemnum}`
        } else if (name === 'monthcard') {
            count(1)
            const quantity = integer(args[0])
            const sdk = Number(
                    c.tables.get('mall_game').find((x) => x.title === 'MONTHLY_CADR_PURCHASE_SDK_ID')?.value ?? 5001,
                ),
                config =
                    c.tables.find('monthly_card', sdk) ??
                    c.tables.get('monthly_card').find((x) => x.purchaseSdkID === sdk)
            ensure(config, 'Monthly card configuration missing')
            const resultCard = purchaseMonthly(c, config, quantity)
            syncPlayer({ ...c, push: c.pushBefore })
            c.pushBefore('SCProtoMonthlyCardInfoSync', monthlyPayload(c.state, resultCard.first))
            result = 'Monthly card +' + config.day * quantity + ' days'
        } else if (name === 'level') {
            count(1)
            const level = integer(args[0], Math.max(...c.tables.get('player_level').map((x) => x.id)))
            ensure(c.tables.find('player_level', level), 'Unknown player level')
            c.state.player.basic_info.lv = level
            c.state.player.basic_info.exp = 0
            syncPlayer({ ...c, push: c.pushBefore }, { basic_info: c.state.player.basic_info })
            result = `Player level ${level}`
        } else if (name === 'heal') {
            count(0)
            for (const hero of c.state.player.heros_info.heros) {
                const max = heroBattleLimits(heroModules(c.tables, c.state, hero))
                const battle = c.state.player.heros_info.battle_infos.find((b) => b.hero_id === hero.guid)
                if (battle) Object.assign(battle, { hp: max.hp, sp: max.sp, alive_state: 0 })
            }
            syncBattle({ ...c, push: c.pushBefore })
            result = 'Owned heroes healed'
        } else if (name === 'tp' || name === 'teleport') {
            count(1)
            const point = c.tables.find('world_borthpos', integer(args[0], 0xffffffff))
            ensure(point, 'Unknown birth point')
            rememberMap(c, point.cityId)
            Object.assign(c.state.world, c.tables.position(point))
            worldSync({ ...c, push: c.pushBefore })
            syncBattle({ ...c, push: c.pushBefore })
            result = `Teleported to ${point.id}`
        } else if (name === 'taskgoal') {
            count(0)
            graphs ??= new TaskGraphs(c.tables)
            const task = currentTask(c.tables, c.state)
            ensure(task, 'No active task')
            const graph = graphs.get(task.task_id),
                node = task.nodes?.[0]
            ensure(node, 'Current task has no active flow')
            const config = graph.nodes.get(node.node_id)
            ensure(config, 'Current task node is unavailable', 1007)
            const conditions = nodeConditions(config),
                index = conditions.findIndex(
                    (condition, i) =>
                        !conditionSatisfied(
                            condition,
                            conditionValue(condition, c.state, {
                                taskId: task.task_id,
                                nodeId: node.node_id,
                                index: i,
                            }),
                        ),
                )
            ensure(index >= 0, 'Current task flow has no incomplete objective')
            const value = conditionTargetValue(conditions[index]),
                key = deliveryKey(c.state, task.task_id, node.node_id, index)
            c.state.taskGoalOverrides ??= {}
            c.state.taskGoalOverrides[key] = value
            node.node_values ??= []
            node.node_values[index] = value
            c.pushBefore('CSProtoTaskSync', taskSnapshot(c.tables, c.state))
            result = `Completed task goal ${task.task_id}/${node.node_id}/${index}`
        } else if (name === 'unlockmaps') {
            count(0)
            const points = [
                ...new Set(
                    c.tables
                        .get('world_borthpos')
                        .map((point) => Number(point.id))
                        .filter((id) => Number.isInteger(id) && id > 0),
                ),
            ].sort((a, b) => a - b)
            c.state.world.points = points
            c.state.world.unlockAllMaps = true
            c.pushBefore('CSProtoTaskSync', taskSnapshot(c.tables, c.state))
            c.pushBefore('CSProtoWorldMapPointSync', { u32s: points })
            result = `Unlocked all world maps and ${points.length} transfer points`
        } else ensure(false, 'Unknown GM command. ' + help)
        const history = (c.state.gmHistory ??= [])
        history.push({ command: name, args, time: c.now })
        if (history.length > 32) history.splice(0, history.length - 32)
        return result
    }
    const run = (c, commands) => {
        ensure(commands.length > 0 && commands.length <= 32, 'GM batch size must be 1..32')
        const results = commands.map((command) => execute(c, command))
        c.push('CSProtoGMCommandsSync', { result: Buffer.from(results.join('\n')).toString('base64') })
        return {}
    }
    on('GMCommand', (c, r) => run(c, [r]))
    on('GMCommands', (c, r) => run(c, r.cmds ?? []))
    return (c, text) => run(c, [{ command: Buffer.from(text).toString('base64') }])
}
