import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { recordPetCaress, recordAnniversaryReport, registerClientReports } from '../src/client-reports.js'
import { achievementCatalogue } from '../src/achievements.js'
import { achievementStateValue } from '../src/achievement-state-progress.js'

const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
const home = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
const state = () => ({ world: { map_id: home }, pets: [{ guid: '101' }, { guid: '102' }] })
const eventIds = new Set(Object.values(protocol.root.lookupEnum('cs.AnnivClientEventId').values).filter((id) => id > 0))

test('6555 counts interactions independently from6534 favor, including capped pets', () => {
    const s = state()
    s.pets[0].daily_favor_count = 999
    for (let i = 0; i < 10; i++) recordPetCaress(tables, s, '101')
    assert.equal(s.petCaressProgress.maximum, 10)
    assert.equal(s.pets[0].daily_favor_count, 999)
    assert.equal(s.petRevision, undefined)
    assert.equal(achievementCatalogue(tables).rules.get(4020048).supported, true)
    assert.equal(achievementStateValue(tables, s, [16022, 10], new Map()), 10)
    recordPetCaress(tables, s, '102')
    assert.deepEqual(s.petCaressProgress, { guid: '102', consecutive: 1, maximum: 10 })
    const before = structuredClone(s)
    assert.throws(() => recordPetCaress(tables, s, '999'), /not owned/)
    assert.deepEqual(s, before)
    s.world.map_id = home + 1
    assert.throws(() => recordPetCaress(tables, s, '101'), /home scene/)
})

test('9976 records actual NPC reports with omitted numeric value and exact64-bit values', () => {
    const s = state()
    const report = protocol.decode(
        'cs.CSAnnivStatReport',
        protocol.encode('cs.CSAnnivStatReport', {
            events: [
                { event_id: 5005, str_value: '{"entityId":"501","type":"AnnivStatNpcDialogTypeWorldMapNpc"}' },
                { event_id: 5008, entity_id: '18446744073709551615', value: '9223372036854775807' },
            ],
        }),
    )
    recordAnniversaryReport(s, report, 1800000000, eventIds, 'connection:9976:1')
    const before = structuredClone(s)
    recordAnniversaryReport(s, report, 1800000000, eventIds, 'connection:9976:1')
    assert.deepEqual(s, before)
    assert.equal(s.anniversaryClientReports.received, 2)
    assert.equal(s.anniversaryClientReports.recent[0].value, '0')
    assert.equal(s.anniversaryClientReports.recent[1].entity_id, '18446744073709551615')
    assert.equal(s.anniversaryClientReports.recent[1].value, '9223372036854775807')
    assert.throws(() => recordAnniversaryReport(s, { events: [{ event_id: 999999 }] }, 1800000000, eventIds), /Unknown/)
    assert.deepEqual(s, before)
})

test('9151 is a notification and cannot complete a dungeon or change a map', () => {
    const handlers = new Map()
    registerClientReports((name, handler) => handlers.set(name, handler), protocol)
    assert.deepEqual([...handlers.keys()], ['PetCaressCount', 'AnnivClientReport', 'MapLoadFinish'])
    const s = { ...state(), storyCampaign: { status: 2, map_id: home }, tasks: [] }
    const pushes = []
    assert.equal(
        handlers.get('MapLoadFinish')({
            state: s,
            tables,
            now: 1800000000,
            push: (name, value) => pushes.push({ name, value }),
        }),
        undefined,
    )
    assert.deepEqual(pushes, [{ name: 'CSProtoSceneModeChange', value: { mode: 3 } }])
    assert.deepEqual(s.world.map_load_finished, { map_id: home, time: 1800000000 })
    assert.equal(s.world.map_id, home)
    assert.equal(s.storyCampaign.status, 2)
    assert.equal(protocol.byName.get('CSProtoMapLoadFinish').rsp, undefined)
})
