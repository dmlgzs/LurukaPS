import assert from 'node:assert/strict'

// The current IL caches mutate before the request callbacks run. This model
// follows their merge/removal and table-filter rules, not Unity UI rendering.
export class ObtInventoryConsumer {
    constructor(tables, protocol) {
        this.tables = tables
        this.protocol = protocol
        this.heroes = new Map()
        this.items = new Map()
        this.souls = new Map()
        this.ornaments = new Map()
        this.battle = new Map()
        this.shops = new Map()
        this.attributes = new Map()
        this.basic = {}
        this.callbacks = new Map()
    }
    onAck(name, callback) {
        this.callbacks.set(this.protocol.byName.get('CSProto' + name).id, callback)
    }
    consumePackets(packets) {
        for (const packet of packets) {
            const entry = this.protocol.byId.get(packet.id)
            if (!entry?.rsp) continue
            const data = this.protocol.decode(entry.rsp, packet.payload)
            if (packet.id === 5001) this.player(data.data)
            else if (entry.name === 'CSProtoSyncPlayerData') this.player(data)
            else if (entry.name === 'CSProtoAllEquipOrnamentSync') {
                this.ornaments.clear()
                this.accessories(data.ornaments)
            } else if (entry.name === 'CSProtoUpdateOrnament') {
                this.accessories(data.ornaments)
                for (const guid of data.guid ?? []) this.ornaments.delete(String(guid))
            } else if (entry.name === 'CSProtoHeroAttrInfoSync')
                for (const hero of data.heros ?? []) this.battle.set(hero.hero_guid, structuredClone(hero))
            else if (entry.name === 'SCProtoShopInfoSync') {
                // Current shopAction.rsp_syncShopInfos / syncGoodsList.
                const info = data.shop_info
                const old = this.shops.get(info.shop_id) ?? { slots: new Map() }
                Object.assign(old, { start: info.begin_time, end: info.end_time })
                for (const slot of info.shop_items ?? []) old.slots.set(slot.slot_id, structuredClone(slot))
                this.shops.set(info.shop_id, old)
            }
            if (this.callbacks.has(packet.id)) {
                const callback = this.callbacks.get(packet.id)
                this.callbacks.delete(packet.id)
                callback(this, data)
            }
        }
    }
    player(data = {}) {
        Object.assign(this.basic, data.basic_info)
        for (const hero of data.heros_info?.heros ?? [])
            this.heroes.set(hero.guid, { ...this.heroes.get(hero.guid), ...structuredClone(hero) })
        for (const attribute of data.attr_infos?.attrs ?? [])
            this.attributes.set(attribute.attr_id, BigInt(attribute.attr_val))
        // BagManager.rsp_syncBagInfo060297d8 removes zero-count GUID entries.
        for (const item of data.sbag_infos?.items ?? []) {
            const key = String(item.guid)
            if (!item.itemnum) this.items.delete(key)
            else if (this.tables.find('common_item', item.itemid)) this.items.set(key, structuredClone(item))
        }
        // SoulEssenceManager0600f699 ignores unknown configurations, refreshes
        // existing instances in place, and removes del_pos after the merge.
        for (const soul of data.soulessence_infos?.soulessences ?? [])
            if (this.tables.find('soulessence', soul.id)) this.souls.set(String(soul.guid), structuredClone(soul))
        for (const guid of data.soulessence_infos?.del_pos ?? []) this.souls.delete(String(guid))
    }
    accessories(rows = []) {
        for (const item of rows)
            if (this.tables.find('accessory', item.id)) this.ornaments.set(String(item.guid), structuredClone(item))
    }
    count(id) {
        return [...this.items.values()]
            .filter((item) => item.itemid === id)
            .reduce((sum, item) => sum + item.itemnum, 0)
    }
    favor(heroId) {
        const hero = [...this.heroes.values()].find((hero) => hero.conf_id === heroId)
        assert(hero, 'Gift callback cannot resolve hero')
        // Gift callback06029873 reads the already-cached HeroData, computes
        // cumulative experience through level-1, then subtracts its beforeExp.
        return (
            this.tables
                .get('hero_favorability_exp')
                .filter((row) => row.favorabilityLevel < hero.favorability_lv)
                .reduce((sum, row) => sum + row.favorabilityExp, 0) + hero.favorability_exp
        )
    }
    equipment(heroGuid) {
        const hero = this.heroes.get(heroGuid)
        assert(hero, 'Equipment callback cannot resolve hero')
        if (hero.wguid) {
            const soul = this.souls.get(String(hero.wguid))
            assert(soul, 'Equipment callback cannot resolve soul')
            assert.equal(soul.wear_hero, heroGuid)
        }
        for (const guid of hero.oguid ?? []) {
            if (!guid) continue
            const ornament = this.ornaments.get(String(guid))
            assert(ornament, 'Equipment callback cannot resolve accessory')
            assert.equal(ornament.wear_hero, heroGuid)
        }
        assert(this.battle.has(heroGuid), 'Equipment callback has no battle attributes')
        return this.battle.get(heroGuid)
    }
}
