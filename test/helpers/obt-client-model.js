import assert from 'node:assert/strict'

const clone = (value) => structuredClone(value)
const u64 = (value = '0') => BigInt(value)
const key = (value) => u64(value).toString()
const proofKey = (value) =>
    Buffer.from(value ?? '', value instanceof Uint8Array ? undefined : 'base64').toString('base64')

// A deliberately partial consumer, independent of server business helpers.
// See client-simulation-agent/FINDINGS.md for IL tokens and unmodelled paths.
export class ObtClientModel {
    constructor(tables, protocol) {
        this.tables = tables
        this.protocol = protocol
        this.heroes = new Map()
        this.groups = new Map()
        this.vehicles = new Map()
        this.inventory = new Map()
        this.trace = []
        this.sceneMode = undefined
        this.mountAttempts = []
        this.claimStates = new Map()
        this.claimRewardViews = []
        this.mailbox = {
            version: undefined,
            summary: undefined,
            mails: new Map(),
            deleted: new Set(),
            events: [],
            needsSync: false,
            needsSummary: false,
        }
    }

    consumePackets(packets) {
        return packets.map((packet) => this.consumePacket(packet))
    }

    consumePacket(packet) {
        const entry = this.protocol.byId.get(packet.id)
        assert(entry?.rsp, `Server emitted a response for request-only/unknown protocol ${packet.id}`)
        return this.consume(packet.id, this.protocol.decode(entry.rsp, packet.payload))
    }

    consume(id, data) {
        this.trace.push({ id, data: clone(data) })
        const name = this.protocol.byId.get(id)?.name
        if (id === 5001) this.applyPlayerData(data.data)
        else if (name === 'CSProtoSyncPlayerData') this.applyPlayerData(data)
        else if (id === 6592) {
            // VehicleData.Populate 0601c0e1 does not clear previously received attributes.
            for (const vehicle of data.owned_vehicles ?? []) Object.assign(this.vehicle(vehicle.guid), clone(vehicle))
        } else if (id === 10006) {
            for (const actor of data.heros ?? [])
                if (actor.type === 32) {
                    // MountStore.SyncVehicleAttrInfo creates an unconfigured shell if needed.
                    const vehicle = this.vehicle(actor.hero_guid)
                    vehicle.modules ??= new Map()
                    for (const module of actor.modules ?? []) vehicle.modules.set(module.module_type, clone(module))
                    vehicle.injectedAttributes = [...vehicle.modules.values()].flatMap((module) =>
                        (module.sub_modules ?? []).flatMap((sub) => sub.attrs?.attrs ?? []),
                    )
                }
        } else if (id === 11055) {
            // SceneProxy.SetOnlineMode 06028437 stores the value. Its current
            // OnlineSPC callback is empty; table readiness is checked separately.
            this.sceneMode = data.mode ?? 0
        } else if (name === 'CSProtoWorldMapSync') {
            for (const player of data.map_info?.players ?? [])
                if (u64(player.mount) >> 56n === 32n) {
                    this.mountAttempts.push({ guid: key(player.mount), ...this.resolveVehicle(player.mount) })
                }
        } else if (id === 5900) this.applyMailSummary(data)
        else if (id === 5901) this.applyMailPage(data)
        else if (id === 5902) for (const delta of data.deltas ?? []) this.applyMailDelta(delta)
        else if (id === 5907) this.applyMailDelta(data.delta)
        else if (id === 5903 && !(data.code ?? 0) && data.result && !(data.result.code ?? 0))
            this.applyMailDelta(data.delta)
        else if (id === 5906) {
            // Native claim callback 0601bca2 merges results before applying delta.
            this.mergeClaimResults(data.results)
            this.applyMailDelta(data.delta)
        }
        if (Array.isArray(data.rewards)) this.assertRewardReferences(data.rewards)
        return data
    }

    applyPlayerData(data) {
        if (data?.basic_info && Object.hasOwn(data.basic_info, 'sex')) this.playerSex = data.basic_info.sex
        for (const hero of data?.heros_info?.heros ?? []) {
            const id = key(hero.guid)
            this.heroes.set(id, { ...this.heroes.get(id), ...clone(hero) })
        }
        for (const manager of data?.group_mgrs ?? []) {
            const old = this.groups.get(manager.type) ?? { groups: [] }
            const groups = new Map(old.groups.map((group) => [group.id, group]))
            for (const group of manager.groups ?? []) groups.set(group.id, clone(group))
            this.groups.set(manager.type, { ...old, ...clone(manager), groups: [...groups.values()] })
        }
        for (const item of data?.sbag_infos?.items ?? [])
            this.inventory.set(key(item.guid), { ...this.inventory.get(key(item.guid)), ...clone(item) })
    }

    assertHeroReferences() {
        // HeroData.SetConfigIds 06029d61: trial IDs are resolved through hero_interim.
        for (const hero of this.heroes.values()) {
            let id = hero.conf_id
            const trial = Object.hasOwn(hero, 'trail') ? hero.trail : u64(hero.guid) >> 56n === 5n
            if (trial) {
                const serverId = Number((u64(hero.guid) >> 32n) & 0xffffffn)
                const interim = this.tables.find('hero_interim', serverId)
                id = interim?.heroId ?? serverId
                if (interim?.heroType === 1) {
                    // TDHeroInterim.GetHeroId 06023b80 chooses the current
                    // player's configured protagonist for main-role trials.
                    const title =
                        this.playerSex === 1
                            ? 'AVATAR_HERO_ID_MALE'
                            : this.playerSex === 2
                              ? 'AVATAR_HERO_ID_FEMALE'
                              : null
                    id = title
                        ? Number(
                              this.tables.get('game').find((row) => row.title === title)?.value ??
                                  (this.playerSex === 1 ? 199002 : 199001),
                          )
                        : 0
                }
            }
            const definition = this.tables.find('hero', id)
            assert(definition, `Client hero config is unavailable: ${id}`)
            assert(
                this.tables.find('unit', definition.unitId),
                `Client hero unit is unavailable: ${id}/${definition.unitId}`,
            )
        }
        for (const group of this.groups.get(1)?.groups ?? []) {
            for (const member of group.heros ?? [])
                if (u64(member.hero_id))
                    assert(this.heroes.has(key(member.hero_id)), `Formation hero is unavailable: ${member.hero_id}`)
            if (u64(group.control))
                assert(this.heroes.has(key(group.control)), `Controlled hero is unavailable: ${group.control}`)
        }
        return this.heroes.size
    }

    vehicle(guid) {
        const id = key(guid)
        if (!this.vehicles.has(id)) this.vehicles.set(id, { guid: id, conf_id: 0, injectedAttributes: [] })
        return this.vehicles.get(id)
    }

    resolveVehicle(guid) {
        // MountFactory.CreateVehicleMountDataByGuid 06029b3b returns empty data
        // for an uncached GUID; an attribute-only shell still has config zero.
        if (u64(guid) >> 56n !== 32n) return { canCreate: false, reason: 'guid-is-not-a-vehicle' }
        const vehicle = this.vehicles.get(key(guid))
        if (!vehicle) return { canCreate: false, reason: 'vehicle-not-cached' }
        const definition = this.tables.find('vehicle', vehicle.conf_id)
        if (!definition) return { canCreate: false, reason: 'vehicle-config-missing' }
        const unit = this.tables.find('unit', definition.unitId)
        if (!unit) return { canCreate: false, reason: 'vehicle-unit-missing' }
        return {
            canCreate: true,
            configId: definition.id,
            unitId: definition.unitId,
            injectedAttributes: clone(vehicle.injectedAttributes),
        }
    }

    assertVehicleReady(guid) {
        const result = this.resolveVehicle(guid)
        assert(result.canCreate, `Vehicle cannot be created: ${result.reason}`)
        // A producer completeness invariant: the current client can cache a
        // shell without attrs; this is not claimed to be a native throw branch.
        assert(
            result.injectedAttributes.some((attr) => attr.attr_id === 35),
            'Vehicle server attributes are not ready for injection',
        )
        return result
    }

    assertSceneModeConfigured() {
        const row = this.tables.find('scene_mode', this.sceneMode)
        assert(row, `Scene mode has no current table entry: ${this.sceneMode}`)
        return row
    }

    mapLoadFinishedRequest() {
        // CutWorldFlow.OnComplete 0602f5c7 sends 9151 with null payload/callback.
        return { id: 9151, payload: Buffer.alloc(0) }
    }

    assertRewardReferences(rewards) {
        const names = new Map([
            [1, 'hero'],
            [3, 'common_item'],
            [10, 'currency'],
            [41, 'vehicle'],
        ])
        for (const reward of rewards)
            if (names.has(reward.itemtype))
                assert(
                    this.tables.find(names.get(reward.itemtype), reward.itemid),
                    `Reward config is unavailable: ${reward.itemtype}/${reward.itemid}`,
                )
    }

    applyMailSummary(response) {
        if ((response.code ?? 0) || !response.summary) return false
        const version = u64(response.summary.mailbox_version),
            box = this.mailbox
        if (box.version === undefined) {
            box.version = version
            box.summary = clone(response.summary)
        } else if (version > box.version) {
            box.summary = clone(response.summary)
            box.needsSync = true
        } else if (version === box.version) box.summary = clone(response.summary)
        box.needsSummary = false
        return true
    }

    applyMailPage(response) {
        if (response.code ?? 0) return false
        const box = this.mailbox,
            version = u64(response.mailbox_version),
            stale = box.version !== undefined && version < box.version
        for (const mail of response.mails ?? [])
            if (u64(mail.mail_id)) {
                const id = key(mail.mail_id)
                if (!(stale && (box.deleted.has(id) || box.mails.has(id)))) box.mails.set(id, clone(mail))
            }
        if (response.summary && (box.version === undefined || version >= box.version))
            box.summary = clone(response.summary)
        if (box.version === undefined) box.version = version
        else if (version > box.version) box.needsSync = true
        return true
    }

    applyMailDelta(delta) {
        if (!delta) return 'ignored'
        const box = this.mailbox,
            version = u64(delta.mailbox_version),
            base = u64(delta.base_version)
        let status
        // MailStore.ApplyMailboxDeltaInternal 0601bc71: branch order matters.
        if (delta.reset_required) {
            box.mails.clear()
            box.deleted.clear()
            box.summary = clone(delta.summary)
            box.version = delta.summary ? u64(delta.summary.mailbox_version) : version
            status = 'reset'
        } else if (box.version === undefined) {
            box.needsSummary = true
            status = 'resync'
        } else if (base < box.version) status = 'ignored'
        else if (base > box.version || version !== base + 1n) {
            box.needsSync = true
            status = 'resync'
        } else {
            for (const change of delta.changes ?? []) {
                if (change.type === 1 && change.mail && u64(change.mail.mail_id))
                    box.mails.set(key(change.mail.mail_id), clone(change.mail))
                else if (change.type === 2 && u64(change.mail_id)) {
                    box.mails.delete(key(change.mail_id))
                    box.deleted.add(key(change.mail_id))
                }
            }
            box.version = version
            if (delta.summary) box.summary = clone(delta.summary)
            status = 'applied'
        }
        box.events.push({ status, base: base.toString(), version: version.toString() })
        return status
    }

    mailClaimRequest(mailId, requestId = Buffer.alloc(16, 1)) {
        // Native RequestClaimMails 0601bc2e deliberately does not set claim_id.
        return { selector: 1, mails: [{ mail_id: key(mailId) }], request_id: proofKey(requestId) }
    }

    mergeClaimResults(results = []) {
        let accepted = 0
        for (const result of results) {
            const proof = proofKey(result?.claim_id),
                id = key(result?.mail_id),
                status = result?.status ?? 0
            if (id === '0' || Buffer.from(proof, 'base64').length !== 16 || ![1, 2, 3, 4].includes(status)) continue
            const old = this.claimStates.get(proof)
            if (old && (old.mailId !== id || [3, 4].includes(old.status) || status < old.status)) continue
            this.claimStates.set(proof, { mailId: id, status, code: result.code ?? 0 })
            accepted++
            if (status === 3) {
                const rewards = clone(result.rewards?.rewards ?? [])
                this.assertRewardReferences(rewards)
                this.claimRewardViews.push(...rewards)
                const mail = this.mailbox.mails.get(id)
                if (mail) {
                    mail.claimed = true
                    mail.read = true
                }
            }
        }
        return accepted
    }
}
