import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { weeklyQuotaView } from '../src/weekly-dungeons.js'

export function createWeeklyStoryFixture(name, { pastTaskIds = [] } = {}) {
    const traceDirectory =
        process.env.LURUKAPS_WEEKLY_STORY_TRACE_DIR ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-weekly-story-trace-'))
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    let nowMs = 1800000000000,
        sequence = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
        rng: () => 0,
    })
    const trace = []
    const context = () =>
        store.read(session.id, (s) => ({
            map: s.world.map_id,
            run: s.entrust?.run
                ? {
                      id: s.entrust.run.entrust_id,
                      stage: s.entrust.run.stage_index,
                      instance: s.entrust.run.instance_id,
                      status: s.entrust.run.status,
                      battleStart: s.entrust.run.battle_start_time,
                      complete: s.entrust.run.battle_complete,
                      story: s.entrust.run.materialStory
                          ? {
                                storyId: s.entrust.run.materialStory.story_id,
                                phase: s.entrust.run.materialStory.phase,
                                startedAt: s.entrust.run.materialStory.started_at,
                                playbackAt: s.entrust.run.materialStory.playback_started_at,
                            }
                          : null,
                  }
                : null,
            enemies: Object.values(s.combat?.entities ?? {})
                .filter((row) => row.object_id)
                .map(({ uuid, object_id, hp, alive_state }) => ({ uuid, object_id, hp, alive_state })),
        }))
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, 'current request ' + name)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        }
    }
    const dispatch = (request, who = session) => {
        const entry = protocol.byId.get(request.id)
        try {
            const packets = game.dispatch(who, request)
            trace.push({
                id: entry.id,
                name: entry.name,
                packetIds: packets.map((packet) => packet.id),
                context: context(),
            })
            return packets
        } catch (error) {
            trace.push({
                id: entry.id,
                name: entry.name,
                error: error.message,
                code: error.code,
                context: session.id ? context() : null,
            })
            throw error
        }
    }
    const call = (name, data = {}, who) => dispatch(frame(name, data), who)
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name, reconnect: true })
    }
    const state = () => store.load(session.id).state
    login()
    store.transact(session.id, Math.floor(nowMs / 1000), (s) => {
        s.player.basic_info.lv = 70
        s.taskRecords ??= []
        const archived = [106013, 106027, ...pastTaskIds]
        for (const task_id of archived)
            if (!s.taskRecords.some((row) => row.task_id === task_id))
                s.taskRecords.push({ task_id, count: 1, time: 1790000000 })
        // Only remove active rows directly contradicted by those exact archived completions.
        s.tasks = s.tasks.filter((row) => !archived.includes(row.task_id))
        s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
        s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: '1790000000' }
        s.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '10000'
        s.player.attr_infos.attrs.find((row) => row.attr_id === 104).attr_val = String(
            weeklyQuotaView(tables, s, Math.floor(nowMs / 1000)).limit,
        )
    })
    const catalog = getEntrustCatalog(tables)
    const run = () => state().entrust?.run
    const decode = (packets) =>
        packets.map((packet) => ({
            id: packet.id,
            name: protocol.byId.get(packet.id)?.name,
            data: protocol.byId.get(packet.id)?.rsp
                ? protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
                : undefined,
        }))
    const packet = (packets, name) => {
        const entry = protocol.byName.get(name)
        assert(entry, name)
        const found = packets.find((value) => value.id === entry.id)
        return found ? protocol.decode(entry.rsp, found.payload) : undefined
    }
    const ready = () => [...call('MultiCampaignPlayerLoaded'), ...call('MultiCampaignPlayerLoadFinish')]
    const enter = (weeklyId) => {
        const row = tables.find('dungeon_weekly', weeklyId)
        assert(!state().weeklyDungeonRecords?.[weeklyId]?.success_count, 'target weekly victory is not seeded')
        const packets = call('MultiCampaignCreate', { dungeon_id: row.dungeonId, scene_type: 12 })
        packets.push(...ready())
        assert.equal(run().entrust_id, weeklyId)
        assert.equal(run().kind, 'weekly')
        assert.equal(state().world.map_id, run().map_id)
        return packets
    }
    const plan = () => {
        const value = materialStoryPlan(tables, run())
        assert(value, 'current weekly plan capability')
        return value
    }
    const positionForTrigger = () => {
        const value = plan()
        store.transact(session.id, 0, (s) => {
            s.world.pos = { ...value.pos }
        })
    }
    const trigger = () =>
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: plan().trigger_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
    const boss = () =>
        Object.values(state().combat?.entities ?? {}).filter((entity) => entity.object_id === plan().boss_id)
    const hp = () =>
        boss()
            .map(({ uuid, hp, alive_state, pack_id }) => ({ uuid, hp, alive_state, pack_id }))
            .sort((a, b) => a.uuid.localeCompare(b.uuid))
    const damageFrame = (partial = false) => {
        const s = state(),
            enemies = boss().filter((enemy) => enemy.hp > 0)
        assert(enemies.length > 0)
        assert.equal(s.world.map_id, run().map_id)
        const hero = s.player.heros_info.heros.find((hero) =>
            s.player.heros_info.battle_infos.some((info) => info.hero_id === hero.guid && info.hp > 0),
        )
        assert(hero)
        nowMs += 2
        return frame('BattleInfoReduce', {
            base_time: String(nowMs),
            uint64_dic: [hero.guid, ...enemies.map((enemy) => enemy.uuid)],
            battle_info: enemies.map((enemy, index) => ({
                hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: partial ? -1 : -enemy.hp },
            })),
        })
    }
    const hurt = (partial = false) => dispatch(damageFrame(partial))
    const protectedState = () => {
        const s = state()
        return structuredClone({
            world: s.world,
            run: s.entrust?.run,
            records: s.weeklyDungeonRecords,
            quota: s.weeklyDungeonQuota,
            player: s.player,
            pets: s.pets,
            ornaments: s.ornaments,
            accepted: s.acceptedCultTrials,
        })
    }
    const rawSQL = () => ({
        player: store.db.prepare('SELECT state,revision,updated_at FROM players WHERE account_id=?').get(session.id),
        requests: store.db
            .prepare(
                'SELECT id,account_id,message_id,status,created_at FROM request_log WHERE account_id=? ORDER BY id',
            )
            .all(session.id),
        sequences: store.db.prepare('SELECT name,value FROM sequences ORDER BY name').all(),
        sqliteSequences: store.db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all(),
    })
    const balance = (id) => BigInt(state().player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? 0)
    const assets = () => {
        const s = state()
        return structuredClone({
            bag: s.player.sbag_infos,
            attrs: s.player.attr_infos,
            ornaments: s.ornaments,
            pets: s.pets,
        })
    }
    const chest = () => catalog.chest(run().entrust_id, 'weekly')
    const reply = (name, packets) => packet(packets, 'CSProto' + name)
    const assertBossPublishedBeforeStory = (packets) => {
        const rows = decode(packets),
            storyIndex = rows.findIndex((row) => row.id === protocol.byName.get('SCProtoPlayerStoryStart').id)
        assert(storyIndex >= 0, 'real11270 start must be emitted')
        const before = rows.slice(0, storyIndex),
            p = plan(),
            expected = boss()
        const worlds = before
            .filter((row) => row.name === 'CSProtoWorldMapSync')
            .flatMap((row) => row.data?.map_info?.objs ?? [])
        const group = worlds.find((row) => row.obj_id === p.boss_id && row.active)?.expand_data?.battle_group
        assert(group, 'real active target WorldObj published before11270')
        assert.equal(group.monsters.length, expected.length)
        for (const enemy of expected)
            assert(
                group.monsters.some((monster) => String(monster.uid) === enemy.uuid && monster.hp > 0),
                'each actual slot must precede11270',
            )
        assert(
            before.some(
                (row) =>
                    row.name === 'SCProtoObjAppearNtf' &&
                    String(row.data.agent_uid) === ((3n << 56n) | BigInt(p.boss_id)).toString(),
            ),
            'actual group AOI precedes11270',
        )
        return rows[storyIndex].data
    }
    return {
        tables,
        protocol,
        store,
        game,
        trace,
        state,
        run,
        frame,
        dispatch,
        call,
        login,
        session: () => session,
        ready,
        enter,
        plan,
        positionForTrigger,
        trigger,
        boss,
        hp,
        damageFrame,
        hurt,
        protectedState,
        rawSQL,
        balance,
        assets,
        chest,
        reply,
        packet,
        decode,
        assertBossPublishedBeforeStory,
        advanceMs: (value) => {
            assert(Number.isSafeInteger(value) && value >= 0)
            nowMs += value
        },
        nowMs: () => nowMs,
        now: () => Math.floor(nowMs / 1000),
        close: () => {
            const directory = traceDirectory
            fs.mkdirSync(directory, { recursive: true })
            fs.writeFileSync(
                path.join(directory, name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.trace.json'),
                JSON.stringify(
                    { qualifiedPastTasks: [106013, 106027, ...pastTaskIds], trace, final: context() },
                    null,
                    2,
                ) + '\n',
            )
            store.close()
        },
    }
}
