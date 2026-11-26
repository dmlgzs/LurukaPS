import assert from 'node:assert/strict'

// A small current-IL cache/recreation consumer. It intentionally does not
// simulate Unity resource loading or asynchronous entity creation.
export class ObtAppearanceConsumer {
    constructor(tables, protocol) {
        this.tables = tables
        this.protocol = protocol
        this.heroes = new Map()
        this.skills = new Map()
        this.groups = new Map()
        this.palettes = new Map()
        this.facePresets = new Map()
        this.skinOwnership = new Map(
            tables
                .get('hero_clothing')
                .filter((row) => row.hero > 0 && row.hero === row.clothingid)
                .map((row) => [row.hero, new Set([row.hero])]),
        )
        this.unlockedClothes = new Set()
        this.wardrobe = { parts: new Map(), avatars: new Map() }
        this.clothes = { parts: [] }
        this.status = 0
        this.mount = '0'
        this.callbacks = new Map()
    }
    onAck(id, callback) {
        this.callbacks.set(id, callback)
    }
    consumePackets(packets) {
        for (const packet of packets) this.consume(packet)
    }
    consume(packet) {
        const entry = this.protocol.byId.get(packet.id)
        assert(entry?.rsp, `Unknown response ${packet.id}`)
        const data = this.protocol.decode(entry.rsp, packet.payload)
        if (packet.id === 5001) this.player(data.data)
        else if (entry.name === 'CSProtoSyncPlayerData') this.player(data)
        else if (packet.id === 10006)
            for (const actor of data.heros ?? []) {
                this.skills.set(
                    actor.hero_guid,
                    new Map(
                        (actor.modules ?? [])
                            .flatMap((module) => (module.sub_modules ?? []).flatMap((sub) => sub.skills?.skills ?? []))
                            .map((skill) => [skill.skill_id, skill]),
                    ),
                )
            }
        else if (packet.id === 9815)
            for (const preset of data.info_list ?? []) {
                const part = preset.parts.find((part) => part.type === 1)
                if (part)
                    this.palettes.set(
                        `${preset.sex}:${preset.clothesid}:${preset.present}`,
                        part.colors.map((color) => color.color_id ?? 0),
                    )
            }
        else if (packet.id === 9813)
            for (const preset of data.info_list ?? [])
                this.facePresets.set(`${preset.sex}:${preset.present}`, structuredClone(preset))
        else if (entry.name === 'SCProtoClothesInfoSync')
            for (const id of data.unlock_clothes ?? []) this.unlockedClothes.add(id)
        else if (entry.name === 'SCProtoHeroSkinMessageSync')
            for (const row of data.hero_skin_info ?? []) {
                // Current HeroStore converts hero_id to a config-ID int32 key.
                const configId = Number(BigInt.asIntN(32, BigInt(row.hero_id)))
                if (this.skinOwnership.has(configId)) this.skinOwnership.set(configId, new Set(row.skin_id))
            }
        else if (entry.name === 'CSProtoWorldMapSync')
            for (const player of data.map_info?.players ?? []) {
                if (player.player_id !== this.id) continue
                if (player.status !== undefined) this.status = player.status
                if (player.mount !== undefined) this.mount = player.mount
                if (player.group?.control) this.control = player.group.control
                // RefindMountRider06029fb9 uses the formation's current control
                // index, never an old mount metadata hero or the first party slot.
                if (this.status === 1) this.rider = this.control
            }
        if (this.callbacks.has(packet.id)) {
            const callback = this.callbacks.get(packet.id)
            this.callbacks.delete(packet.id)
            callback(this)
        }
        return data
    }
    player(data = {}) {
        const basic = data.basic_info
        if (basic?.id !== undefined) this.id = basic.id
        if (basic?.wardrobe) this.face(basic.wardrobe)
        // MyPlayerData.SyncPlayerWardrobeInfo06029dab also populates decorations.
        if (basic?.clothes_info) this.clothes = structuredClone(basic.clothes_info)
        for (const hero of data.heros_info?.heros ?? []) {
            this.heroes.set(hero.guid, { ...this.heroes.get(hero.guid), ...structuredClone(hero) })
            if (hero.type === 1) this.defaultHero = hero.guid
        }
        for (const manager of data.group_mgrs ?? [])
            if (manager.type === 1) {
                const old = this.groups.get(1) ?? { groups: [] }
                const groups = new Map(old.groups.map((group) => [group.id, group]))
                for (const group of manager.groups ?? []) groups.set(group.id, structuredClone(group))
                const next = { ...old, ...manager, groups: [...groups.values()] }
                this.groups.set(1, next)
                const group = groups.get(next.cur_group)
                if (group?.control) this.control = group.control
                if (this.status === 1) this.rider = this.control
            }
    }
    face(info) {
        // PlayerWardrobeData.Populate06029ddd retains fields omitted/defaulted
        // in a facial patch; PopulateDecorate has different replacement rules.
        for (const field of ['sex', 'height', 'complexion']) if (info[field]) this.wardrobe[field] = info[field]
        this.wardrobe.present = info.present ?? 0
        for (const avatar of info.avatars ?? []) this.wardrobe.avatars.set(avatar.avatar_type, avatar.avatar_url ?? '')
        for (const part of info.parts ?? [])
            if (part.type) {
                const old = this.wardrobe.parts.get(part.type) ?? {}
                const next = { ...old, type: part.type }
                if (part.id) next.id = part.id
                if (part.colors?.length) next.colors = structuredClone(part.colors)
                if (part.color_formular_ids) next.color_formular_ids = [...part.color_formular_ids]
                this.wardrobe.parts.set(part.type, next)
            }
    }
    facialSnapshot() {
        return {
            sex: this.wardrobe.sex,
            height: this.wardrobe.height,
            complexion: this.wardrobe.complexion,
            parts: [...this.wardrobe.parts.values()],
            avatars: [...this.wardrobe.avatars],
        }
    }
    recreate(guid = this.defaultHero) {
        // Both the11903 clothing callback06016c35 and5023 callback06015b9e
        // clear/recreate entities using data already cached before the ACK.
        const hero = this.heroes.get(guid)
        assert(hero, `Recreation cannot resolve hero ${guid}`)
        const clothingId = hero.hero_skin || hero.conf_id
        const clothing = this.tables.get('hero_clothing').find((row) => row.clothingid === clothingId)
        assert(
            clothing && this.tables.find('unit', clothing.unitId),
            `Recreation cannot resolve clothing ${clothingId}`,
        )
        return {
            guid,
            clothingId,
            unitId: clothing.unitId,
            battleInfo: clothing.battleInfo,
            skills: new Map(this.skills.get(guid) ?? []),
            face: this.facialSnapshot(),
            clothes: structuredClone(this.clothes),
            control: this.control,
            mount: this.mount,
            status: this.status,
        }
    }
}
