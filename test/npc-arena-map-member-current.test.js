import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set both diagnostic sinks before any dynamic Game/module import. No live DB.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-map-member-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(scratch, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(scratch, 'reward-source.jsonl')
const [
    configModule,
    playerModule,
    protocolModule,
    storeModule,
    gameModule,
    memberModule,
    trainerModule,
    duelModule,
    errors,
] = await Promise.all([
    import('../src/config.js'),
    import('../src/player.js'),
    import('../src/protocol.js'),
    import('../src/store.js'),
    import('../src/game.js'),
    import('../src/current-map-member.js'),
    import('../src/npc-kibo-trainer.js'),
    import('../src/npc-kibo-duel.js'),
    import('../src/error-codes.js'),
])
const config = configModule.configuration(),
    tables = new playerModule.Tables(config.tables)
const { currentMapMember } = memberModule,
    { ErrorCode } = errors

function fixture(name) {
    const protocol = new protocolModule.Protocol(config.base),
        store = new storeModule.Store(':memory:')
    let session = {},
        seq = 1
    const game = new gameModule.Game(protocol, store, tables, {
        clock: () => 1795695240,
        arenaClockMs: () => 1795695240000,
        syncOptimization: false,
    })
    const state = () => store.load(session.id).state
    const call = (name, request = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        assert(row, 'current alias ' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: seq++,
            payload: row.req ? protocol.encode(row.req, request) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name, reconnect: true })
    }
    const decode = (packets) =>
        packets.map((packet) => {
            const row = protocol.byId.get(packet.id)
            return {
                id: packet.id,
                name: row?.name,
                data: row?.rsp ? protocol.decode(row.rsp, packet.payload) : undefined,
            }
        })
    const bases = (packets) => {
        const row = protocol.byName.get('CSProtoMultiCampaignBaseInfoSync')
        return decode(packets)
            .filter((packet) => packet.id === row.id)
            .map((packet) => packet.data)
    }
    const assets = () => {
        const s = state()
        return structuredClone({
            pets: s.pets,
            heroes: s.player.heros_info.heros,
            bag: s.player.sbag_infos,
            ornaments: s.ornaments ?? [],
            soulessences: s.player.soulessence_infos,
            currencies: s.player.attr_infos,
            basic: {
                gold: s.player.basic_info.gold,
                diamond: s.player.basic_info.diamond,
                exp: s.player.basic_info.exp,
                lv: s.player.basic_info.lv,
            },
            results: s.kiboDuelRecords ?? {},
        })
    }
    login()
    call('KiboDuelGetGroup', { u32: 1002 })
    const group = structuredClone(state().kiboDuelGroups[0]),
        used = new Set(group.pet_guids.filter((p) => !p.is_trial).map((p) => String(p.id))),
        available = state().pets.filter((p) => !used.has(String(p.guid)))
    for (const slot of group.pet_guids)
        if (String(slot.id) === '0') {
            const owned = available.shift()
            assert(owned)
            slot.id = owned.guid
            slot.is_trial = false
        }
    call('KiboDuelGroupChange', { type: 6, group })
    const hero = state().player.heros_info.heros.find((h) => h.guid === state().kiboDuelGroups[0].hero)
    assert.equal(hero.conf_id, 199001, 'actual selected current arena trainer')
    return {
        protocol,
        store,
        game,
        state,
        call,
        login,
        decode,
        bases,
        assets,
        hero,
        id: () => session.id,
        entry: () => call('MultiCampaignCreate', { dungeon_id: 40014 }),
        close: () => store.close(),
    }
}

function assertBase(f, packets) {
    const entries = f.bases(packets)
    assert(entries.length > 0, 'actual9567 must be present')
    const s = f.state(),
        hero = s.player.heros_info.heros.find((h) => h.guid === f.hero.guid)
    for (const base of entries) {
        assert.equal(base.dungeon_id, 40014)
        assert.equal(base.player_list.length, 1)
        const member = base.player_list[0]
        assert.equal(member.pid, f.id())
        assert.equal(member.data.name, Buffer.from(s.player.basic_info.name, 'base64').toString('utf8'))
        assert.equal(member.data.lv, s.player.basic_info.lv)
        assert.equal(member.data.group.control_hero, 199001)
        assert.deepEqual(member.data.group.hero_list, [
            { hero_id: 199001, hero_level: hero.hero_lv, hero_skin_id: hero.hero_skin || 199001 },
        ])
        const normalize = (field, value) => {
            const payloadType = f.protocol.root.lookupType('scene.InitMapMember').fields.data.resolvedType,
                typeName = payloadType.fields[field].resolvedType.fullName
            // The actual wire decoder adds omitted repeated defaults. Keep
            // strict source-field validation through the real codec as well.
            return f.protocol.decode(typeName, f.protocol.encode(typeName, value))
        }
        if (s.player.basic_info.wardrobe)
            assert.deepEqual(member.data.wardrobe, normalize('wardrobe', s.player.basic_info.wardrobe))
        if (s.player.basic_info.clothes_info)
            assert.deepEqual(member.data.clothes, normalize('clothes', s.player.basic_info.clothes_info))
        for (const old of ['player_id', 'hero_id', 'name', 'lv', 'heros'])
            assert(!Object.hasOwn(member, old), 'no retired flat member field ' + old)
        assert.deepEqual(base.team_option_list, [{ player_id: f.id(), stay: true }])
        assert.deepEqual(base.player_status_list, [{ player_id: f.id(), status: 1 }])
    }
    return entries
}

test('40014 current10751/11701/9510 stream publishes the actual arena trainer and ready/cold-login preserves normal return policy', () => {
    const f = fixture('npc-member-stream-current')
    try {
        const normal = currentMapMember(f.state(), f.id()),
            owned = f.assets(),
            origin = f.state().world.map_id
        assert.notEqual(
            normal.data.group.control_hero,
            199001,
            'normal world formation deliberately differs from NPC trainer',
        )
        const entry = f.entry()
        assertBase(f, entry)
        const decoded = f.decode(entry),
            create = f.protocol.byName.get('CSProtoMultiCampaignCreate')
        assert(!create.rsp, 'current9510 is request-only,without a reply schema')
        assert(!decoded.some((packet) => packet.id === create.id), 'do not invent a9510 ACK')
        assert.equal(decoded.length, 15, 'decode the complete current owned40014 entry stream')
        assert(
            decoded.every((packet) => packet.data !== undefined),
            'every stream packet uses its actual schema',
        )
        assert.deepEqual(
            currentMapMember(f.state(), f.id()),
            normal,
            'two-argument normal formation projection remains unchanged',
        )
        const start = f.state().multiCampaign.start_time
        const unready = f.state()
        assert.throws(
            () => f.call('MultiCampaignPlayerLoadFinish'),
            (error) =>
                error.code === ErrorCode.InvalidArgument && error.message === 'Arena entities have not been published',
        )
        assert.deepEqual(f.state(), unready)
        // Current ClientReadyTask0602f676 sends9596. The arena's
        // TryReportPlayerLoadFinish0602e154 waits for actual entities before9602.
        const published = f.decode(f.call('MultiCampaignPlayerLoaded'))
        assert(published.some((packet) => packet.id === f.protocol.byName.get('SCProtoBatchObjAppearNtf').id))
        assert.equal(f.state().combat.npcDuel.entities_sent, true)
        const ownRoster = published
                .find((packet) => packet.id === f.protocol.byName.get('SCProtoKiboDuelPVPAllInfoSync').id)
                .data.player_info.find((player) => player.player_id === f.id()),
            ownCard = published
                .find((packet) => packet.id === f.protocol.byName.get('CSProtoKiboDuelArenaPlayerBaseInfo').id)
                .data.infos.find((player) => player.player_id === f.id())
        // Current OnSocket_11700 binds m_MyHeroGuid from this self roster;
        // GetMyPlayerControllingEntity resolves that UUID, not ordinary9103 control.
        assert.equal(ownRoster.attr.hero_info.hero_guid, f.hero.guid)
        assert.equal(ownRoster.attr.hero_info.hero_conf_id, 199001)
        assert.equal(ownRoster.attr.hero_info.hero_lv, f.hero.hero_lv)
        assert.equal(ownCard.hero_guid, ownRoster.attr.hero_info.hero_guid)
        assert.equal(ownCard.hero_conf_id, ownRoster.attr.hero_info.hero_conf_id)
        assert.equal(f.state().combat.npcDuel.trainer_guid, ownRoster.attr.hero_info.hero_guid)

        f.decode(f.call('MultiCampaignPlayerLoadFinish'))
        f.decode(f.call('MultiCampaignPlayerLoadingPageComplete'))
        assert.equal(f.state().multiCampaign.start_time, start)
        assert.deepEqual(f.assets(), owned)
        // Current repairPendingDuelEntry intentionally returns a complete
        // active runtime to preparation on cold login; do not force resume.
        f.decode(f.login())
        assert.equal(f.state().multiCampaign, undefined)
        assert.equal(f.state().world.map_id, origin)
        assert.deepEqual(f.assets(), owned)
        f.call('KiboDuelGetGroup', { u32: 1002 })
        assertBase(f, f.entry())
        assert.deepEqual(f.assets(), owned)
    } finally {
        f.close()
    }
})

test('40014 pending metadata with explicitly lost transient combat cache exercises private Game relogin member wrapper', () => {
    const f = fixture('npc-member-pending-compat-current')
    try {
        assertBase(f, f.entry())
        const campaign = structuredClone(f.state().multiCampaign),
            owned = f.assets()
        assert.equal(f.state().combat.npcDuel.version, 1)
        // Controlled compatibility input: only transient cache loss after an
        // actual entry,within60s. No result,owned asset or permission is added.
        f.store.transact(f.id(), 0, (s) => {
            delete s.combat
        })
        const restored = f.login()
        assert.equal(
            f.state().multiCampaign.duel_id,
            campaign.duel_id,
            'existing pending branch retains actual metadata',
        )
        assert.equal(f.state().multiCampaign.start_time, campaign.start_time)
        assertBase(f, restored)
        assert.deepEqual(f.assets(), owned)
    } finally {
        f.close()
    }
})

test('40014 member encoding failure rolls back actual entry SQL,pending,assets and replay does not add another arena origin', () => {
    const f = fixture('npc-member-codec-current')
    try {
        const id = f.id(),
            before = f.state(),
            owned = f.assets(),
            pending = f.store.pending.get(id),
            pendingState = pending?.state,
            pendingCopy = structuredClone(pending)
        const sql = () => ({
            player: f.store.db.prepare('SELECT state,revision,updated_at FROM players WHERE account_id=?').get(id),
            requests: f.store.db
                .prepare(
                    'SELECT id,account_id,message_id,status,created_at FROM request_log WHERE account_id=? ORDER BY id',
                )
                .all(id),
            sequences: f.store.db.prepare('SELECT name,value FROM sequences ORDER BY name').all(),
        })
        const raw = sql(),
            encode = f.protocol.encode,
            type = f.protocol.byName.get('CSProtoMultiCampaignBaseInfoSync').rsp
        let failures = 0
        f.protocol.encode = function (name, ...args) {
            if (name === type) {
                failures++
                throw Error('npc member stream codec fault')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.entry(), /npc member stream codec fault/)
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(failures, 1, 'actual9567 response encoder hook must be invoked')
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.assets(), owned)
        assert.deepEqual(sql(), raw)
        assert.strictEqual(f.store.pending.get(id), pending)
        assert.strictEqual(f.store.pending.get(id)?.state, pendingState)
        assert.deepEqual(f.store.pending.get(id), pendingCopy)
        assertBase(f, f.entry())
        const campaign = structuredClone(f.state().multiCampaign),
            history = structuredClone(f.state().worldHistory)
        assertBase(f, f.entry())
        assert.deepEqual(f.state().multiCampaign, campaign)
        assert.deepEqual(f.state().worldHistory, history)
        assert.deepEqual(f.assets(), owned)
    } finally {
        f.close()
    }
})

test('currentMapMember retains default projection and accepts only registered owned or current typed trial-role sources', () => {
    const f = fixture('npc-member-source-current')
    try {
        const state = f.state(),
            normal = currentMapMember(state, f.id()),
            manager = state.player.group_mgrs.find((m) => m.type === 1),
            formation = manager.groups.find((g) => g.id === manager.cur_group),
            control = state.player.heros_info.heros.find((h) => String(h.guid) === String(formation.control))
        assert.equal(normal.data.group.control_hero, control.conf_id)
        assert.equal(currentMapMember(state, f.id(), { hero: f.hero }).data.group.control_hero, 199001)
        const bad = [
            null,
            {},
            { hero: null },
            { hero: f.hero, unexpected: true },
            { hero: { ...f.hero, guid: '999999999999999999' } },
            { hero: { ...f.hero, conf_id: 1 } },
            { hero: { ...f.hero, hero_lv: 0 } },
            { hero: { ...f.hero, hero_skin: 1 } },
        ]
        for (const options of bad)
            assert.throws(
                () => currentMapMember(state, f.id(), options),
                (e) => e.code === ErrorCode.GameConfig,
            )
        const duel = tables.find('kibo_duel', 502),
            interim = tables.find('hero_interim', duel.trialRole)
        assert.equal(duel.trialRole, 107001)
        assert(tables.find('hero', interim.heroId) && !interim.accessorySet && !interim.talentrune)
        const entry = duelModule.npcDuelEntry(tables, duel.id),
            pure = structuredClone(state),
            owned = structuredClone(pure.player.heros_info.heros)
        pure.world.map_id = Number(entry.map.art)
        pure.multiCampaign = { duel_id: duel.id, map_id: pure.world.map_id, dungeon_id: duel.dungeonId }
        const trainer = trainerModule.prepareArenaTrainer(tables, pure, duel, { hero: f.hero.guid })
        assert.equal(trainer.trail, true)
        const member = currentMapMember(pure, f.id(), { hero: trainer })
        assert.equal(member.data.group.control_hero, interim.heroId)
        assert.deepEqual(member.data.group.hero_list, [
            { hero_id: interim.heroId, hero_level: interim.level, hero_skin_id: interim.heroId },
        ])
        assert.deepEqual(pure.player.heros_info.heros, owned, 'pure trial projection never creates an owned hero')
        pure.multiCampaign.duel_id = 1002
        assert.throws(
            () => currentMapMember(pure, f.id(), { hero: trainer }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        pure.multiCampaign.duel_id = duel.id
        pure.world.map_id = 100
        assert.throws(
            () => currentMapMember(pure, f.id(), { hero: trainer }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})
