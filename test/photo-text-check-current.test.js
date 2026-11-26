import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { checkPhotoText } from '../src/photo-text-check.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1,
        session = {}
    const frame = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) }
    }
    const dispatch = (packet) => game.dispatch(session, packet),
        call = (name, r) => dispatch(frame(name, r)),
        state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'photo-text-' + name })
    assert.equal(state().mall?.popupQueue?.length ?? 0, 0)
    assert.equal(state().mall?.pendingPopup, undefined)
    const warm = call('GetRechargePopupData').find((p) => p.id === 18048)
    assert.equal(protocol.decode(protocol.byId.get(warm.id).rsp, warm.payload).popup_id ?? 0, 0)
    return {
        store,
        game,
        session,
        frame,
        dispatch,
        call,
        state,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: 'photo-text-' + name, reconnect: true })
        },
        raw: () => ({
            state: state(),
            sql: store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        }),
    }
}
class PhotoCallbackModel {
    text = '旧文'
    lastCheckText = null
    open = true
    horizontal = true
    layoutCalls = 0
    accept(input, error = 0) {
        if (error !== 0) {
            this.lastCheckText = input
            return
        }
        this.lastCheckText = null
        this.text = input
        this.rendered = this.horizontal ? input : '<rotate=90>' + input
        this.layoutCalls += 2
        this.open = false
    }
    canSend(text) {
        return !(this.lastCheckText && text === this.lastCheckText)
    }
}
test('current exact whitelist bucket0 and native14 half-width UTF16 units accept Han/Japanese/Korean/halfwidth kana and legitimate clear', () => {
    for (const text of ['春日和风', '桜の春風', '안녕하세요', '汉'.repeat(7), 'ｱ'.repeat(14), '（）', '', undefined])
        assert.deepEqual(checkPhotoText(tables, { data_info: text }), { data_info: text ?? '' })
    for (const text of ['汉'.repeat(8), 'ｱ'.repeat(15), 'ABC', '汉 A', '汉\n', '汉\0', '😀', '\ufffd', '\ud800'])
        assert.throws(
            () => checkPhotoText(tables, { data_info: text }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
    assert.throws(
        () => checkPhotoText(tables, null),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    assert.throws(
        () => checkPhotoText(tables, { data_info: 123 }),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    const missing = { get: () => [] }
    assert.throws(
        () => checkPhotoText(missing, {}),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const corrupt = { get: () => [{ Id: 1, isName: 0, unicode_start: '9FFF', unicode_end: '4E00' }] }
    assert.throws(
        () => checkPhotoText(corrupt, {}),
        (e) => e.code === ErrorCode.GameConfig,
    )
    // Exact isName key, not a union of all ranges or the unrelated name bucket.
    const separate = {
        get: () => [
            { Id: 1, isName: 0, unicode_start: '4E00', unicode_end: '9FFF' },
            { Id: 2, isName: 1, unicode_start: '30A0', unicode_end: '30FF' },
        ],
    }
    assert.deepEqual(checkPhotoText(separate, { data_info: '汉' }), { data_info: '汉' })
    assert.throws(
        () => checkPhotoText(separate, { data_info: 'カ' }),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
})
test('real9812 plain UTF8 string echo drives current success callback horizontal/vertical/clear without caption persistence or rewards', () => {
    const f = fixture('success')
    try {
        const before = structuredClone(f.state())
        for (const text of ['春日和风', 'ｱ'.repeat(14), '']) {
            const frames = f.call('GeneralDirtyCheck', { data_info: text }),
                reply = frames.find((p) => p.id === 9812),
                body = protocol.decode(protocol.byId.get(9812).rsp, reply.payload)
            assert.equal(body.data_info ?? '', text)
            assert(!frames.some((p) => [18048, 6517, 11880].includes(p.id)))
            const horizontal = new PhotoCallbackModel()
            horizontal.accept(text, reply.error ?? 0)
            assert.equal(horizontal.rendered, text)
            assert.equal(horizontal.open, false)
            const ui = new PhotoCallbackModel()
            ui.horizontal = false
            ui.accept(text, reply.error ?? 0)
            assert.equal(ui.text, text)
            assert.equal(ui.rendered, '<rotate=90>' + text)
            assert.equal(ui.open, false)
            assert.equal(ui.layoutCalls, 2)
        }
        assert.deepEqual(
            f.state(),
            before,
            'text is local photo UI state; server does not invent saved caption/history',
        )
    } finally {
        f.store.close()
    }
})
test('real malformed/unavailable characters fail atomically; current nonzero callback preserves input box and rejects same last failed text locally', () => {
    const f = fixture('reject')
    try {
        const before = f.raw()
        for (const text of ['汉'.repeat(8), 'ASCII', '😀', '汉\0'])
            assert.throws(
                () => f.call('GeneralDirtyCheck', { data_info: text }),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
        assert.deepEqual(f.raw(), before)
        // Source-derived negative callback vector, not a claim official moderation runs.
        const ui = new PhotoCallbackModel()
        ui.accept('候选文本', ErrorCode.InvalidArgument)
        assert.equal(ui.text, '旧文')
        assert.equal(ui.open, true)
        assert.equal(ui.layoutCalls, 0)
        assert.equal(ui.canSend('候选文本'), false)
        assert.equal(ui.canSend('新的文本'), true)
        ui.accept('新的文本', 0)
        assert.equal(ui.lastCheckText, null)
        assert.equal(ui.text, '新的文本')
        assert.equal(ui.open, false)
    } finally {
        f.store.close()
    }
})
test('9812 response codec and SQL failure preserve complete state; retry/repeated requests/relogin never create saved photo text or grant rewards', () => {
    for (const fault of ['codec', 'sql']) {
        const f = fixture(fault)
        try {
            const request = f.frame('GeneralDirtyCheck', { data_info: '春日晴风' }),
                before = f.raw(),
                encode = protocol.encode
            if (fault === 'codec')
                protocol.encode = function (type, value) {
                    if (type === protocol.byId.get(9812).rsp) throw Error('photo response codec failure')
                    return encode.call(this, type, value)
                }
            else
                f.store.db.exec(
                    "CREATE TRIGGER fail_photo BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'photo SQL failure'); END",
                )
            try {
                assert.throws(
                    () => f.dispatch(request),
                    new RegExp('photo ' + (fault === 'codec' ? 'response codec' : 'SQL') + ' failure'),
                )
            } finally {
                protocol.encode = encode
                if (fault === 'sql') f.store.db.exec('DROP TRIGGER fail_photo')
            }
            assert.deepEqual(f.raw(), before)
            const successful = f.dispatch(request).find((p) => p.id === 9812)
            assert.equal(protocol.decode(protocol.byId.get(9812).rsp, successful.payload).data_info, '春日晴风')
            f.call('GeneralDirtyCheck', { data_info: '春日晴风' })
            assert.deepEqual(f.state(), before.state)
            const assets = structuredClone({ bag: f.state().player.sbag_infos, attrs: f.state().player.attr_infos })
            assert(!f.reconnect().some((p) => p.id === 9812))
            assert.deepEqual({ bag: f.state().player.sbag_infos, attrs: f.state().player.attr_infos }, assets)
        } finally {
            f.store.close()
        }
    }
})
test('invalid UTF8 wire does not become an accepted replacement character', () => {
    const f = fixture('utf8')
    try {
        const before = f.raw(),
            bad = f.frame('GeneralDirtyCheck', { data_info: '' })
        // field1 length2 followed by a non-canonical UTF8 sequence.
        bad.payload = Buffer.from([0x0a, 0x02, 0xc0, 0x80])
        assert.throws(
            () => f.dispatch(bad),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.raw(), before)
    } finally {
        f.store.close()
    }
})
