import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { announcementHttpData, announcementBody } from '../src/announcements.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    now = 1800000000
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert.ok(entry, 'actual current protocol ' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    const packets = call('EnterGame', { open_id: 'current-retired-routes' }),
        wire = protocol.decode(protocol.byId.get(5001).rsp, packets.find((p) => p.id === 5001).payload).data
    return {
        store,
        game,
        session,
        call,
        wire,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}

test('1.0 formation5981 full hero/pet vector replaces5980 editing and keeps control/selection across login', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-current-formation-')),
        filename = path.join(directory, 'state.sqlite')
    let f = fixture(filename)
    try {
        const heroes = f.wire.heros_info.heros.filter((hero) => !hero.trail && hero.type !== 2).slice(0, 2)
        assert.equal(heroes.length, 2)
        const manager = f.state().player.group_mgrs.find((row) => row.type === 1),
            groupId = manager.cur_group
        f.edit((s) => {
            const group = s.player.group_mgrs.find((row) => row.type === 1).groups.find((row) => row.id === groupId)
            group.heros = heroes.map((hero) => ({ hero_id: hero.guid, pet_id: '0' }))
            group.control = heroes[0].guid
        })
        const info = heroes
            .slice()
            .reverse()
            .map((hero) => ({ hero_guid: hero.guid, pet_guid: '0' }))
        f.call('QuickChangeGroupInfo', { type: 1, id: groupId, infos: info })
        const group = f
            .state()
            .player.group_mgrs.find((row) => row.type === 1)
            .groups.find((row) => row.id === groupId)
        assert.deepEqual(
            group.heros.map((row) => row.hero_id),
            info.map((row) => row.hero_guid),
        )
        assert.equal(group.control, heroes[0].guid)
        f.close()
        f = fixture(filename)
        const restored = f
            .state()
            .player.group_mgrs.find((row) => row.type === 1)
            .groups.find((row) => row.id === groupId)
        assert.deepEqual(restored, group)
        assert.equal(protocol.byName.has('CSProtoChangeHeroGroupIndex'), false)
    } finally {
        f.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-current-formation-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('1.0 clothes5023 actual SaveData vector applies costume and adornment while retaining legacy apparel save', () => {
    const f = fixture()
    try {
        const before = f.state(),
            basic = before.player.basic_info,
            parts = structuredClone(basic.clothes_info.parts),
            costume = tables
                .get('clothing_item')
                .find(
                    (row) =>
                        row.typeId === 1 &&
                        row.id !== parts.find((p) => p.type === 1).id &&
                        (basic.sex === 1 ? row.clothingAvatarM : row.clothingAvatarF),
                ),
            adornment = tables
                .get('clothing_item')
                .find((row) => row.typeId === 2 && (basic.sex === 1 ? row.resPathM : row.resPathF))
        assert.ok(costume)
        assert.ok(adornment)
        const updated = parts.filter((row) => row.type !== 1 && row.type !== 2)
        updated.push({ type: 1, id: costume.id }, { type: 2, id: adornment.id })
        const vector = { parts: updated, sex: basic.sex, present: 0, clothesid: costume.id }
        f.call('PlayerClothesInfoChange', vector)
        const expected = protocol.decode('cs.ClothesInfo', protocol.encode('cs.ClothesInfo', vector))
        assert.deepEqual(f.state().player.basic_info.clothes_info, expected)
        assert.deepEqual(f.state().player.basic_info.apparel_info, basic.apparel_info)
        assert.equal(protocol.byName.has('CSProtoPlayerApparelInfoChange'), false)
    } finally {
        f.close()
    }
})

test('current reading get is server reward28, then real11027 preserves read ownership and repeated rewards/relogin', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-current-reading-')),
        filename = path.join(directory, 'state.sqlite')
    let f = fixture(filename)
    try {
        const rewards = parseRewards(tables.find('task', 107016).taskReward).filter((row) => row.itemtype === 28)
        assert.equal(rewards.length, 2)
        f.edit((s) => {
            for (const reward of rewards) if (s.readingBooks) delete s.readingBooks[reward.itemid]
            grantRewards(tables, s, rewards)
        })
        const ids = rewards.map((row) => row.itemid)
        assert.ok(ids.every((id) => f.state().readingBooks[id].book_state === 0))
        f.call('ReadHandbookRead', { book_id: ids })
        assert.ok(ids.every((id) => f.state().readingBooks[id].book_state === 1))
        f.edit((s) => grantRewards(tables, s, rewards))
        assert.ok(ids.every((id) => f.state().readingBooks[id].book_state === 1))
        f.close()
        f = fixture(filename)
        assert.ok(ids.every((id) => f.state().readingBooks[id].book_state === 1))
        assert.equal(protocol.byName.has('CSProtoReadHandbookGet'), false)
    } finally {
        f.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-current-reading-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('announcement contents remain available through the actual HTTP data/body functions without retired10702', () => {
    const data = announcementHttpData('http://127.0.0.1:20001', now)
    assert.ok(data.infos.length > 0)
    for (const info of data.infos) {
        assert.ok(info.meta.length > 0)
        assert.equal(new URL(info.meta[0].content).origin, 'http://127.0.0.1:20001')
        assert.ok(announcementBody(String(info.id), now))
    }
    assert.equal(protocol.byName.has('CSProtoAnnounceRequest'), false)
})
