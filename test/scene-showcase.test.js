import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { showcaseFixture, sceneData, editScene, editElement } from './scene-showcase-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { publicProfile } from '../src/public-profile.js'
const saved = (f, who = f.a) => f.state(who).player.basic_info.scene_showcase
const save = (f, data, who = f.a) => f.call(who, 'ChangeSceneShowcase', { data })

test('6143 saves actual two-layer JSON with own heroes/pets and all component kinds before null ACK', () => {
    const f = showcaseFixture('save')
    try {
        const data = sceneData(f)
        data.Cover = `${data.id}_${f.a.id}_1800000000`
        const other = f.state(f.b)
        const packets = save(f, data)
        const syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        const sync = packets.find((p) => p.id === syncId)
        assert(packets.indexOf(sync) < packets.findIndex((p) => p.id === 6143))
        assert.deepEqual(f.protocol.decode('ProtoNullRsp', packets.find((p) => p.id === 6143).payload), {})
        assert.deepEqual(f.protocol.decode(f.protocol.byId.get(syncId).rsp, sync.payload).basic_info.scene_showcase, [
            data,
        ])
        assert.deepEqual(saved(f), [data])
        assert.deepEqual(publicProfile(f.state(f.a).player.basic_info).scene_showcase, [data])
        assert.deepEqual(f.state(f.b), other)
        save(f, { ...data, name: '重新命名', Cover: '' })
        assert.equal(saved(f).length, 1)
        assert.equal(saved(f)[0].name, '重新命名')
        assert.equal(saved(f)[0].show_data, data.show_data)
        save(
            f,
            editScene(data, (s) => {
                s.objs = {}
                s.pets = {}
                s.stamps = {}
            }),
        )
        assert.equal(saved(f).length, 1)
    } finally {
        f.store.close()
    }
})

test('6143 derives every slot level from photo_space_case and capacity from situation_tab', () => {
    const f = showcaseFixture('levels')
    try {
        const slots = f.tables.get('photo_space_case')
        assert.deepEqual(
            slots.map((r) => Number(r.unlock.split('#')[1])),
            [1, 2, 10, 20, 30, 40],
        )
        for (const row of slots) {
            const required = Number(row.unlock.split('#')[1])
            if (required > 1) {
                f.store.transact(f.a.id, 0, (s) => {
                    s.player.basic_info.lv = required - 1
                })
                const before = f.state(f.a)
                assert.throws(
                    () => save(f, sceneData(f, row.id)),
                    (e) => e.code === ErrorCode.FunctionClosed,
                )
                assert.deepEqual(f.state(f.a), before)
            }
            f.store.transact(f.a.id, 0, (s) => {
                s.player.basic_info.lv = required
            })
            save(f, sceneData(f, row.id))
        }
        assert.deepEqual(
            saved(f).map((r) => r.id),
            slots.map((r) => r.id),
        )
        const row = f.tables.get('situation_tab').find((r) => r.tabId === 2)
        const before = f.state(f.a)
        assert.throws(
            () =>
                save(
                    f,
                    editScene(sceneData(f), (s) => {
                        s.objs = Array(row.number + 1).fill(s.objs[0])
                    }),
                ),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(f.a), before)
    } finally {
        f.store.close()
    }
})

test('6143 rejects missing/malformed JSON, non-finite vectors, category mixups and illegal cover ownership atomically', () => {
    const f = showcaseFixture('structure')
    try {
        const data = sceneData(f),
            before = f.state(f.a)
        const invalid = [
            { ...data, show_data: 'null' },
            { ...data, show_data: '{' },
            editScene(data, (s) => {
                s.heroes = [JSON.parse(s.heroes[0])]
            }),
            editScene(data, (s) => {
                s.camera = '{}'
            }),
            editScene(data, (s) => {
                s.heroes = undefined
            }),
            editElement(data, 'heroes', (h) => {
                h.pos.x = null
            }),
            editElement(data, 'heroes', (h) => {
                h.actionId = 1101
            }),
            editElement(data, 'pets', (p) => {
                p.faceId = 601
            }),
            editElement(data, 'stamps', (s) => {
                s.scale = 0
            }),
            editScene(data, (s) => {
                s.stamps.push(s.stamps[0])
            }),
            { ...data, Cover: `1_${f.b.id}_1800000000` },
            { ...data, Cover: `2_${f.a.id}_1800000000` },
            { ...data, Cover: 'https://invalid.example/x.png' },
            { ...data, name: 'a\u0000b' },
        ]
        for (const candidate of invalid) {
            assert.throws(
                () => save(f, candidate),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        const huge = editScene(data, (s) => {
            s.heroes[0] = s.heroes[0].replace('"x":0', '"x":1e999')
        }).show_data
        assert.throws(
            () => save(f, { ...data, show_data: huge }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => save(f, { ...data, id: 99 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () =>
                save(
                    f,
                    editElement(data, 'objs', (s) => {
                        s.configId = 999999
                    }),
                ),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(f.a), before)
    } finally {
        f.store.close()
    }
})

test('6143 validates permanent ownership, pet GUID/config and cosmetic data without creating inventory', () => {
    const f = showcaseFixture('ownership')
    try {
        const data = sceneData(f),
            owned = f.state(f.a)
        f.store.transact(f.a.id, 0, (s) => {
            s.player.heros_info.heros = s.player.heros_info.heros.filter((h) => h.type === 1)
        })
        const absent = owned.player.heros_info.heros.find((h) => h.type !== 1)
        assert.throws(
            () =>
                save(
                    f,
                    editElement(data, 'heroes', (h) => {
                        h.heroConfigId = absent.conf_id
                    }),
                ),
            (e) => e.code === ErrorCode.HeroNotExist,
        )
        assert.throws(
            () =>
                save(
                    f,
                    editElement(data, 'pets', (p) => {
                        p.petGuid = '999999999'
                    }),
                ),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        const invalid = [
            editElement(data, 'pets', (p) => {
                p.petConfigId++
            }),
            editElement(data, 'pets', (p) => {
                p.specialParam++
            }),
            editElement(data, 'pets', (p) => {
                p.flashParam = !p.flashParam
            }),
            editElement(data, 'pets', (p) => {
                p.starColorId++
            }),
            editElement(data, 'heroes', (h) => {
                h.clothingId = absent.conf_id
            }),
            editScene(data, (s) => {
                s.heroes.push(s.heroes[0])
            }),
            editScene(data, (s) => {
                s.pets.push(s.pets[0])
            }),
        ]
        const before = f.state(f.a)
        for (const candidate of invalid) {
            assert.throws(
                () => save(f, candidate),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(f.state(f.a), before)
        }
        save(f, data)
        assert.deepEqual(f.state(f.a).pets, before.pets)
        assert.deepEqual(f.state(f.a).player.heros_info, before.player.heros_info)
    } finally {
        f.store.close()
    }
})

test('6143 rejects unknown unlock conditions and corrupted saved slots without partial writes', () => {
    const f = showcaseFixture('config')
    try {
        const data = sceneData(f),
            row = f.tables.find('photo_space_case', 1),
            before = f.state(f.a)
        row.unlock = '13000#1'
        assert.throws(
            () => save(f, data),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(f.a), before)
        row.unlock = '2004#1'
        f.store.transact(f.a.id, 0, (s) => {
            s.player.basic_info.scene_showcase = [data, data]
        })
        const broken = f.state(f.a)
        assert.throws(
            () => save(f, data),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(f.a), broken)
    } finally {
        f.store.close()
    }
})

test('6143 rolls back real protobuf encoding failures including pre-ACK sync', () => {
    const f = showcaseFixture('codec'),
        encode = f.protocol.encode
    try {
        const data = sceneData(f),
            before = f.state(f.a),
            other = f.state(f.b)
        for (const failed of ['cs.SCPlayerDataSync', 'cs.ProtoNullRsp']) {
            const actualSync = f.protocol.byName.get('CSProtoSyncPlayerData').rsp
            const type = failed === 'cs.SCPlayerDataSync' ? actualSync : failed
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('showcase encode failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => save(f, data), /showcase encode failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.deepEqual(f.state(f.b), other)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('6143 survives SQLite close/reopen and is delivered in actual 5001 login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-showcase-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = showcaseFixture('reopen', file)
        const data = sceneData(f)
        save(f, data)
        f.store.close()
        f = showcaseFixture('reopen', file)
        assert.deepEqual(saved(f), [data])
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-showcase-reopen-a' })
        const login = f.protocol.decode(f.protocol.byId.get(5001).rsp, packets.find((p) => p.id === 5001).payload)
        assert.deepEqual(login.data.basic_info.scene_showcase, [data])
        assert.equal(saved(f, f.b), undefined)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-showcase-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
