import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Protocol } from '../src/protocol.js'
import { protocolSchemaShape, protocolSchemaOptions } from '../src/protocol-schema.js'
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const protocol = new Protocol(base)
const schemaDirectory = path.join(base, 'proto/lua/proto')
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
function fixture(
    t,
    entries,
    files = { 'Legacy.proto': 'syntax = "proto2"; package cs; message Legacy { optional uint32 id = 1; }' },
) {
    const prefix = path.resolve(os.tmpdir(), 'lurukaps-protocol-version-')
    const directory = fs.mkdtempSync(prefix)
    fs.mkdirSync(path.join(directory, 'configs'))
    fs.mkdirSync(path.join(directory, 'proto/lua/proto'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'configs/protocol.json'), JSON.stringify(entries))
    for (const [name, source] of Object.entries(files))
        fs.writeFileSync(path.join(directory, 'proto/lua/proto', name), source)
    t.after(() => {
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-protocol-version-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    })
    return directory
}

test('active 1.0.0 IDs expose only evidenced retirement and native request uncertainty', () => {
    assert.equal(protocol.clientVersion, '1.0.0')
    assert.equal(protocol.entries.length, 1021)
    assert.equal(protocol.retiredNames.size, 130)
    assert.deepEqual(
        [...protocol.unknownRequests],
        [9141, 9593, 10760, 11141, 11142, 11143, 11144, 11145, 11146, 11147],
    )
    assert.equal(protocol.byName.get('CSProtoStaminaBoxGiveUp').id, 9979)
    assert.equal(protocol.byName.get('CSProtoActivityGrowUpEventInfoReq').id, 10433)
    assert.equal(protocol.byName.get('CSProtoSetClientCustomOptions').id, 18060)
    assert.equal(protocol.byId.get(9976).name, 'CSProtoAnnivClientReport')
    assert.equal(protocol.byId.get(9902).req, 'cs.CSUint32')
    assert.equal(protocol.byId.get(9141).reqUnknown, true)
    assert.equal(Object.hasOwn(protocol.byId.get(9141), 'req'), false)
    assert.equal(protocol.byId.get(9141).rsp, 'cs.SCWorldObjAIHeroInfoRsp')
    assert.ok(protocol.retiredNames.has('CSProtoNoviceTaskFinish'))
    assert.ok(protocol.retiredNames.has('CSProtoShowJourneyStageWindow'))
    assert.equal(protocol.retiredNames.has('CSProtoJourneyTaskFinsh'), false)
    assert.equal(protocol.byName.has('CSProtoShowJourneyStageWindow'), false)
    assert.deepEqual(protocol.missing, [])
})

test('generated IDL matches its file and schema fingerprints without raw descriptors', () => {
    const names = fs.readdirSync(schemaDirectory)
    assert.equal(names.filter((name) => name.endsWith('.proto')).length, 35)
    assert.equal(
        names.some((name) => name.endsWith('.pb')),
        false,
    )
    assert.equal(protocol.source.idlFiles.length, 35)
    for (const file of protocol.source.idlFiles) {
        const bytes = fs.readFileSync(path.join(schemaDirectory, file.name))
        assert.equal(bytes.length, file.bytes, file.name)
        assert.equal(hash(bytes), file.sha256, file.name)
    }
    const shape = protocolSchemaShape(protocol.root)
    assert.equal(Object.keys(shape).length, protocol.source.schemaDefinitions)
    assert.equal(hash(JSON.stringify(shape)), protocol.source.schemaSha256)
    assert.equal(protocol.source.descriptors.length, 35)
    assert.deepEqual(protocol.source.duplicateDescriptorSymbols, [
        { name: 'cs.CampaignHero', owner: 'PopperParty.proto', duplicate: 'PoppingParty.proto', identical: true },
    ])
    assert.equal(protocol.type('scene.InitMapMember').name, 'InitMapMember')
})

test('custom options retain their generated schema fingerprint and 131 declarations', () => {
    const options = protocolSchemaOptions(protocol.root)
    const count = Object.values(options).reduce(
        (sum, object) => sum + Object.keys(object).filter((name) => name.startsWith('(')).length,
        0,
    )
    assert.equal(count, 131)
    assert.equal(count, protocol.source.customOptionCount)
    assert.equal(hash(JSON.stringify(options)), protocol.source.schemaOptionsSha256)
    assert.equal(protocol.type('cs.ShieldElementData').options['(msg_to_server)'], true)
})

test('new field shapes encode correctly and strict encoding rejects removed or unknown fields', () => {
    const input = {
        itemid: 12,
        itemnum: 3,
        first_get: true,
        full_resonance: true,
        display_items: [{ itemid: 15, itemnum: 2 }],
    }
    const result = protocol.decode('cs.CommonItem', protocol.encode('cs.CommonItem', input))
    assert.equal(result.first_get, true)
    assert.equal(result.full_resonance, true)
    assert.equal(result.display_items[0].itemid, 15)
    assert.throws(() => protocol.encode('cs.CommonItem', { future_field: true }), /Unknown field/)
    assert.throws(() => protocol.encode('cs.CommonItem', { display_items: [{ typo: true }] }), /Unknown field/)
    assert.throws(() => protocol.encode('cs.TitleList', { preffix_title: [1] }), /Unknown field/)
    assert.throws(() => protocol.encode('cs.CSReportOnPlayer', { pid: 1 }), /Unknown field/)
    const report = protocol.decode(
        'cs.CSReportOnPlayer',
        protocol.encode('cs.CSReportOnPlayer', { playerID: [12, 13], reportID: 2, reportEntryID: 3 }),
    )
    assert.deepEqual(report.playerID, [12, 13])
    assert.equal(report.reportID, 2)
})

test('Windows CRLF checkout preserves protocol and IDL fingerprints without weakening content checks', (t) => {
    const crlf = (text) => text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
    const files = Object.fromEntries(
        fs
            .readdirSync(schemaDirectory)
            .filter((name) => name.endsWith('.proto'))
            .map((name) => [name, crlf(fs.readFileSync(path.join(schemaDirectory, name), 'utf8'))]),
    )
    const directory = fixture(t, protocol.entries, files)
    fs.writeFileSync(
        path.join(directory, 'configs/protocol.json'),
        crlf(fs.readFileSync(path.join(base, 'configs/protocol.json'), 'utf8')),
    )
    fs.writeFileSync(path.join(directory, 'configs/protocol-source.json'), JSON.stringify(protocol.source))
    assert.equal(protocol.source.textFingerprint, 'utf8-lf')
    const checked = new Protocol(directory)
    assert.equal(checked.entries.length, 1021)
    assert.deepEqual(checked.missing, [])
    fs.appendFileSync(path.join(directory, 'proto/lua/proto/Activity.proto'), '\r\n// changed content\r\n')
    assert.throws(() => new Protocol(directory), /fingerprint/i)
})

test('base directories without source metadata retain the legacy IDL loading contract', (t) => {
    const directory = fixture(t, [{ id: 12, name: 'Legacy', req: 'cs.Legacy', rsp: 'cs.Legacy' }])
    const old = new Protocol(directory)
    assert.equal(old.clientVersion, undefined)
    assert.equal(old.retiredNames.size, 0)
    assert.equal(old.unknownRequests.size, 0)
    assert.deepEqual(old.decode('Legacy', old.encode('Legacy', { id: 42 })), { id: 42 })
    assert.deepEqual(old.missing, [])
})

test('source metadata corruption, duplicate mappings and conflicting schemas are rejected', (t) => {
    const entries = [{ id: 12, name: 'Legacy', req: 'cs.Legacy' }]
    const directory = fixture(t, entries)
    const source = {
        schemaVersion: 1,
        active: true,
        clientVersion: '1.0.0',
        protocolEntries: 1,
        protocolSha256: hash(fs.readFileSync(path.join(directory, 'configs/protocol.json'))),
        retiredNames: ['Retired'],
        unknownRequestIds: [],
        unknownRequestNames: [],
    }
    const sourceFile = path.join(directory, 'configs/protocol-source.json')
    fs.writeFileSync(sourceFile, JSON.stringify(source))
    assert.equal(new Protocol(directory).retiredNames.has('Retired'), true)
    fs.writeFileSync(sourceFile, JSON.stringify({ ...source, retiredNames: ['Legacy'] }))
    assert.throws(() => new Protocol(directory), /Invalid active protocol source/)
    fs.writeFileSync(sourceFile, JSON.stringify({ ...source, unknownRequestIds: [12] }))
    assert.throws(() => new Protocol(directory), /Invalid active protocol source/)
    fs.writeFileSync(sourceFile, JSON.stringify({ ...source, protocolSha256: 'invalid' }))
    assert.throws(() => new Protocol(directory), /Invalid active protocol source/)
    fs.writeFileSync(sourceFile, JSON.stringify({ ...source, schemaSha256: 'invalid' }))
    assert.throws(() => new Protocol(directory), /schema fingerprint mismatch/)
    fs.writeFileSync(
        sourceFile,
        JSON.stringify({ ...source, idlFiles: [{ name: 'Legacy.proto', bytes: 0, sha256: 'invalid' }] }),
    )
    assert.throws(() => new Protocol(directory), /IDL fingerprint mismatch/)
    const duplicate = fixture(t, [...entries, ...entries])
    assert.throws(() => new Protocol(duplicate), /Duplicate protocol ID/)
    const conflicting = fixture(t, entries, {
        'A.proto': 'syntax = "proto2"; package cs; message Legacy { optional uint32 id = 1; }',
        'B.proto': 'syntax = "proto2"; package cs; message Legacy { optional string id = 1; }',
    })
    assert.throws(() => new Protocol(conflicting), /Conflicting protobuf definition/)
})

test('an unknown native request cannot also masquerade as an empty or declared request', (t) => {
    for (const req of ['', 'cs.Legacy']) {
        const directory = fixture(t, [{ id: 12, name: 'UnknownNative', reqUnknown: true, req }])
        assert.throws(() => new Protocol(directory), /Invalid protocol entry/)
    }
    const directory = fixture(t, [{ id: 12, name: 'UnknownNative', reqUnknown: true }])
    assert.equal(new Protocol(directory).unknownRequests.has(12), true)
})
