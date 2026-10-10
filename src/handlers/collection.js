import { isPreviousTrialActor } from './trial-groups.js'
import { syncBattle } from '../battle.js'
import { reconcileFormationPets } from '../formation-pets.js'
import { mountPayload, repairMountSelection } from '../mounts.js'
import { ensure, textValue, hero, pet, manager, group, syncPlayer, syncPets, syncGroupControl } from './common.js'
import { isHomeMap } from '../home-formation.js'
export function registerCollection(on) {
    const syncFormation = (c, data) => {
        // HomePlayerUnitAdapter creates the default hero independently. Save
        // exploration teams with metadata-only src=1, not an avatar reload.
        if (isHomeMap(c.tables, c.state) && data.group_mgrs)
            data = { ...data, group_mgrs: data.group_mgrs.map((m) => ({ ...m, src: 1 })) }
        syncPlayer(c, data)
    }
    const syncGroups = (c) => {
        syncFormation(c, { group_mgrs: c.state.player.group_mgrs })
        syncBattle(c)
    }
    const syncEquipment = (c) => {
        syncPlayer(c, { heros_info: c.state.player.heros_info, soulessence_infos: c.state.player.soulessence_infos })
        syncPets(c)
        syncBattle(c)
    }
    on('QuickChangeGroupInfo', (c, r) => {
        const g = group(c.state, r.type, r.id),
            infos = r.infos ?? []
        ensure(infos.length >= 1 && infos.length <= 3, 'Invalid quick formation size')
        const heroIds = infos.map((x) => x.hero_guid ?? '0').filter((x) => x !== '0'),
            petIds = infos.map((x) => x.pet_guid ?? '0').filter((x) => x !== '0')
        ensure(heroIds.length > 0 && new Set(heroIds).size === heroIds.length, 'Empty or duplicate heroes')
        ensure(new Set(petIds).size === petIds.length, 'Duplicate pets')
        for (const info of infos) {
            if (info.hero_guid && info.hero_guid !== '0') hero(c.state, info.hero_guid)
            else ensure(!info.pet_guid || info.pet_guid === '0', 'Pet assigned to empty slot')
            if (info.pet_guid && info.pet_guid !== '0') pet(c.state, info.pet_guid)
        }
        // Clear all selected assignments first so simultaneous pet swaps cannot
        // detach a pet that was already moved earlier in the same batch.
        for (const h of c.state.player.heros_info.heros)
            if (heroIds.includes(h.guid) || petIds.includes(h.pet_id)) h.pet_id = '0'
        for (const p of c.state.pets) if (heroIds.includes(p.hero_id) || petIds.includes(p.guid)) p.hero_id = '0'
        for (const info of infos)
            if (info.hero_guid && info.hero_guid !== '0') {
                const h = hero(c.state, info.hero_guid)
                h.pet_id = info.pet_guid || '0'
                if (h.pet_id !== '0') pet(c.state, h.pet_id).hero_id = h.guid
            }
        g.heros = infos.map((info) => ({ hero_id: info.hero_guid || '0', pet_id: info.pet_guid || '0' }))
        reconcileFormationPets(c.state)
        if (!heroIds.includes(g.control)) g.control = heroIds[0]
        const syncContext = { ...c, push: c.pushBefore }
        syncFormation(syncContext, { group_mgrs: c.state.player.group_mgrs, heros_info: c.state.player.heros_info })
        syncPets(syncContext)
        syncBattle(syncContext)
        return {}
    })
    on('ChangeHeroGroupIndex', (c, r) => {
        const old = group(c.state, r.type, r.group?.id)
        ensure(r.group && r.group.heros.length > 0 && r.group.heros.length <= 3, 'Invalid group size')
        const ids = r.group.heros.filter((x) => x.hero_id && x.hero_id !== '0').map((x) => x.hero_id)
        ensure(ids.length > 0 && new Set(ids).size === ids.length, 'Empty or duplicate heroes')
        ids.forEach((id) => hero(c.state, id))
        old.heros = r.group.heros
        old.control = ids.includes(r.group.control) ? r.group.control : ids[0]
        reconcileFormationPets(c.state)
        syncGroups(c)
        return {}
    })
    on('SwitchWorldGroup', (c, r) => {
        const m = manager(c.state, r.type)
        group(c.state, r.type, r.group_id)
        m.last_group = m.cur_group
        m.cur_group = r.group_id
        syncGroups(c)
        return {}
    })
    on('SwitchWorldGroupControl', (c, r) => {
        const g = group(c.state, r.type)
        if (!g.heros.some((h) => h.hero_id === r.control) && isPreviousTrialActor(c.state, r.control)) {
            manager(c.state, r.type).src = 0
            c.push('CSProtoSyncPlayerData', { group_mgrs: c.state.player.group_mgrs })
            return {}
        }
        ensure(
            g.heros.some((h) => h.hero_id === r.control),
            'Control not in group',
        )
        g.control = r.control
        syncGroupControl(c, r.type)
        return {}
    })
    on('ChangeGroupName', (c, r) => {
        const changed = group(c.state, r.type, r.group_id)
        changed.group_name = textValue(r.name, 30)
        // This changes metadata, not the active formation or its attributes.
        syncPlayer(c, { group_mgrs: [{ type: r.type, src: 1, groups: [changed] }] })
        return {}
    })
    on('WearPet', (c, r) => {
        const h = hero(c.state, r.hero_guid)
        const p = r.pet_guid && r.pet_guid !== '0' ? pet(c.state, r.pet_guid) : null
        for (const x of c.state.pets) if (x.hero_id === h.guid) x.hero_id = '0'
        for (const x of c.state.player.heros_info.heros) if (p && x.pet_id === p.guid) x.pet_id = '0'
        h.pet_id = p?.guid || '0'
        if (p) p.hero_id = h.guid
        reconcileFormationPets(c.state)
        syncEquipment(c)
        syncPlayer(c, { group_mgrs: c.state.player.group_mgrs })
        return {}
    })
    on('MoveSoulEssence', (c, r) => {
        const h = hero(c.state, r.hero_id)
        const es = c.state.player.soulessence_infos.soulessences
        const e = r.guid ? es.find((e) => e.guid === r.guid) : null
        ensure(!r.guid || e, 'Soul essence not owned')
        for (const x of es) if (x.wear_hero === h.guid) x.wear_hero = '0'
        for (const x of c.state.player.heros_info.heros) if (e && x.wguid === e.guid) x.wguid = 0
        h.wguid = e?.guid || 0
        if (e) e.wear_hero = h.guid
        syncEquipment(c)
        return {}
    })
    on('SetLockSoulEssence', (c, r) => {
        const ids = r.guids?.length ? r.guids : [r.guid]
        ensure(ids.length > 0)
        for (const id of ids) {
            const e = c.state.player.soulessence_infos.soulessences.find((e) => e.guid === id)
            ensure(e, 'Soul essence not owned')
            e.lock = !!r.lock
        }
        syncPlayer(c, { soulessence_infos: c.state.player.soulessence_infos })
        return {}
    })
    on('PetChangeName', (c, r) => {
        pet(c.state, r.guid).pet_name = textValue(r.pet_name, 20)
        syncPets(c)
        return {}
    })
    on('PetEggLock', (c, r) => {
        const egg = (c.state.petEggs || []).find((e) => String(e.guid) === r.guid)
        ensure(egg, 'Pet egg not owned')
        egg.lock_state = !!r.lock_operate
        c.state.eggRevision = (c.state.eggRevision || 0) + 1
        return {}
    })
    on('PetLock', (c, r) => {
        pet(c.state, r.guid).is_lock = !!r.lock_operate
        syncPets(c)
        return {}
    })
    on('PetSetRoulettePos', (c, r) => {
        ensure(Number.isInteger(r.pos) && r.pos >= 1 && r.pos <= 8, 'Invalid roulette position')
        const p = pet(c.state, r.guid)
        ensure(c.tables.find('mount', p.config_id), 'Pet has no mount configuration')
        for (const x of c.state.pets) if (x.roulette_pos === r.pos) x.roulette_pos = 0
        p.roulette_pos = r.pos
        syncPets(c)
        if (repairMountSelection(c.tables, c.state)) c.push('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
        return {}
    })
    on('PetRemoveRoulettePos', (c, r) => {
        ensure(r.u32 >= 1 && r.u32 <= 8)
        for (const p of c.state.pets) if (p.roulette_pos === r.u32) p.roulette_pos = 0
        syncPets(c)
        if (repairMountSelection(c.tables, c.state)) c.push('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
        return {}
    })
    on('PetBoxRename', (c, r) => {
        const box = c.state.petBoxes.find((b) => b.id === r.box_id)
        ensure(box, 'Unknown pet box')
        box.box_name = textValue(r.box_name, 20)
        c.push('CSProtoPetBoxInfoSync', { box_infos: c.state.petBoxes })
        return {}
    })
    on('ExchangePetBoxId', (c, r) => {
        const a = pet(c.state, r.guid),
            b = pet(c.state, r.target_guid)
        ;[a.box_id, b.box_id] = [b.box_id, a.box_id]
        syncPets(c)
        return {}
    })
}
