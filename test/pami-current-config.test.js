import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { pamiCoverage } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
class PamiConsumer {
    constructor() {
        this.letters = new Map()
    }
    consume(packets, name, request) {
        for (const packet of packets) {
            if (packet.id === 9970) {
                const data = protocol.decode(protocol.byId.get(9970).rsp, packet.payload)
                for (const tab of data.mail_tab ?? [])
                    for (const letter of tab.contents ?? []) {
                        // Current PamiLetter.Populate0601c434 reads groupId
                        // from the list table. MergeData0601c45f then resolves
                        // that group's category; the wire ID is not a hero ID.
                        const row = tables.find('pami_letter_list', letter.mail_id),
                            group = row && tables.find('pami_letter_group', row.groupId)
                        assert(group, 'Pami payload cannot resolve current group')
                        assert.equal(group.categoryId, tab.mail_type)
                        assert(tables.find('pami_letter_category', group.categoryId))
                        assert.equal(tables.find('pami_letter_text', row.firstId)?.letterId, row.id)
                        for (const reply of letter.reply ?? []) {
                            const text = tables.find('pami_letter_text', reply.text_id)
                            assert.equal(text?.letterId, row.id)
                            if (reply.record)
                                assert.equal(tables.find('pami_letter_reply', reply.record)?.teamId, text.teamId)
                        }
                        this.letters.set(letter.mail_id, structuredClone(letter))
                    }
            } else if (packet.id === 9971 && name === 'PamiMailRead') {
                this.letters.get(request.u32).latest_read = true
            } else if (packet.id === 9972 && name === 'PamiMailChoose') {
                // Successful native callback calls ApplyReply0601c462,
                // changing the existing text's reply, never adding a letter.
                for (const letter of this.letters.values()) {
                    const text = letter.reply.find((text) => text.text_id === request.text_id)
                    if (text) {
                        text.record = request.reply_id
                        letter.latest_read = true
                        break
                    }
                }
            }
        }
    }
}

test('current Pami12385 is an isolated unresolved source row, while112002 has a separate fully referenced128 chain', () => {
    const old = tables.find('pami_letter_list', 12385),
        current = tables
            .get('pami_letter_list')
            .filter((row) => row.groupId === 128)
            .sort((a, b) => a.id - b.id),
        coverage = pamiCoverage(tables)
    assert(old)
    assert.equal(tables.find('pami_letter_group', old.groupId), undefined)
    assert.equal(tables.find('pami_letter_text', old.firstId), undefined)
    assert.equal(tables.find('pami_letter_list', 12384), undefined)
    assert.deepEqual(
        coverage.rejected.map((row) => row.id),
        [12385],
    )
    assert.equal(coverage.ordinary + coverage.eventLetters.length + coverage.rejected.length, coverage.configured)
    assert.deepEqual(
        current.map((row) => row.id),
        [12881, 12882, 12883, 12884, 12885],
    )
    assert.equal(tables.find('pami_letter_group', 128).heroId, 112002)
    for (const row of current) assert.equal(tables.find('pami_letter_text', row.firstId)?.letterId, row.id)
    assert.equal(current.at(-1).title, old.title)
    assert.notEqual(current.at(-1).firstId, old.firstId, 'Matching titles do not authorize remapping IDs')
})

test('actual current128 chain reads and replies through9971/9972, remains native-consumable on relog, and preserves quarantined12385 history', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {},
        client = new PamiConsumer(),
        account = 'pami-current-config'
    let seq = 1
    const call = (name, request = {}, consumer = client, target = session) => {
        const entry = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(target, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
            })
        consumer.consume(packets, name, request)
        return packets
    }
    try {
        call('EnterGame', { open_id: account })
        const old = {
            mail_id: 12385,
            hero_id: '0',
            timestamp: 1799999990,
            latest_read: true,
            reply: [{ text_id: 1238501, record: 0, timestamp: 1799999990 }],
            reward: [],
            args: [],
        }
        store.transact(session.id, 0, (state) => {
            // Explicit current permanent ownership fixture. Normal starters do
            // not receive every hero; this is not a default-gift assumption.
            grantRewards(tables, state, [{ itemtype: 1, itemid: 112002, itemnum: 1 }])
            const hero = state.player.heros_info.heros.find((hero) => hero.conf_id === 112002 && !hero.trail)
            assert(hero)
            hero.favorability_lv = 9
            const [kind, taskId, nodeId] = tables
                .find('system_unlock', tables.find('pami_letter_category', 1).systemId)
                .unlockCondi.split('#')
                .map(Number)
            assert.equal(kind, 12045)
            const active = state.tasks.find((task) => task.task_id === taskId)
            if (active) active.finish_nodes = [...new Set([...(active.finish_nodes ?? []), nodeId])]
            else (state.taskRecords ??= []).push({ task_id: taskId, count: 1 })
            state.pamiMail.letters[12385] = structuredClone(old)
        })
        call('EnterGame', { open_id: account, reconnect: true }, client, {})
        const chain = tables
            .get('pami_letter_list')
            .filter((row) => row.groupId === 128)
            .sort((a, b) => a.id - b.id)
        for (let index = 0; index < chain.length; index++) {
            const row = chain[index],
                text = tables.find('pami_letter_text', row.firstId),
                reply = tables
                    .get('pami_letter_reply')
                    .find((choice) => choice.teamId === text.teamId && choice.textId === 0)
            assert(client.letters.has(row.id))
            assert(!client.letters.has(12385))
            if (chain[index + 1]) assert(!client.letters.has(chain[index + 1].id))
            const read = call('PamiMailRead', { u32: row.id })
            assert(read.findIndex((packet) => packet.id === 9970) < read.findIndex((packet) => packet.id === 9971))
            assert(client.letters.get(row.id).latest_read)
            const chosen = call('PamiMailChoose', { text_id: text.id, reply_id: reply.id })
            assert(chosen.findIndex((packet) => packet.id === 9972) < chosen.findIndex((packet) => packet.id === 9970))
            assert.equal(client.letters.get(row.id).reply.length, 1)
            assert.equal(client.letters.get(row.id).reply[0].record, reply.id)
            call('PamiMailChoose', { text_id: text.id, reply_id: reply.id })
            assert.equal(client.letters.get(row.id).reply.length, 1)
        }
        const beforeBad = store.load(session.id)
        assert.throws(
            () => call('PamiMailRead', { u32: 12385 }),
            (error) => error.code === ErrorCode.PamiLetterNotFound,
        )
        assert.throws(
            () => call('PamiMailChoose', { text_id: 1238501, reply_id: 12885501 }),
            (error) => error.code === ErrorCode.PamiLetterTextConfFail,
        )
        assert.deepEqual(store.load(session.id), beforeBad)
        assert.deepEqual(store.load(session.id).state.pamiMail.letters[12385], old)
        const next = new PamiConsumer()
        call('EnterGame', { open_id: account, reconnect: true }, next, {})
        for (const row of chain) assert.deepEqual(next.letters.get(row.id), client.letters.get(row.id))
        assert(!next.letters.has(12385))
    } finally {
        store.close()
    }
})

test('a codec-valid12385 envelope still lacks the current group/text references required by the Pami consumer', () => {
    const client = new PamiConsumer(),
        data = {
            mail_tab: [
                {
                    mail_type: 1,
                    contents: [
                        {
                            mail_id: 12385,
                            hero_id: '0',
                            timestamp: 1800000000,
                            reply: [{ text_id: 1238501, record: 0, timestamp: 1800000000 }],
                        },
                    ],
                },
            ],
        }
    assert.throws(
        () => client.consume([{ id: 9970, payload: protocol.encode(protocol.byId.get(9970).rsp, data) }]),
        /cannot resolve current group/,
    )
})
