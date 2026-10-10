import { syncBattle } from '../battle.js'
import { ensure, textValue, syncPlayer, hero } from './common.js'
import { ensureAppearance, appearanceCatalog, normalizeClothes } from '../appearance.js'
import { initializeCharacterFormation } from '../character-creation.js'
import { repairMainHeroType } from '../main-hero.js'
export function registerCore(on) {
    on('PresetWardrobeReq', (c, r) => {
        ensure([1, 2].includes(r.sex), 'Invalid preset sex')
        // CBT3 GetFirstEmptyPresetIdBySex searches slots 1..3 independently
        // for each sex. Saving a preset must not apply it to the player.
        ensure(Number.isInteger(r.present) && r.present >= 1 && r.present <= 3, 'Invalid wardrobe preset slot')
        ensure(new Set(r.parts.map((part) => part.type)).size === r.parts.length, 'Duplicate wardrobe part')
        const presets = (c.state.wardrobePresets ??= [])
        const index = presets.findIndex((preset) => preset.sex === r.sex && preset.present === r.present)
        if (index < 0) presets.push(r)
        else presets[index] = r
        c.push('SCProtoPresetWardrobeSync', { info_list: presets })
        return {}
    })
    on('HeroUpdateSkin', (c, r) => {
        const actor = hero(c.state, r.hero_guid)
        ensureAppearance(c.tables, c.state)
        const id = r.skin_id || actor.conf_id,
            skin = appearanceCatalog(c.tables).skins.get(id)
        ensure(skin?.hero === actor.conf_id, 'Skin does not belong to this hero')
        ensure(c.state.unlockedHeroSkins[actor.conf_id]?.includes(id), 'Hero skin is not unlocked')
        actor.hero_skin = id
        // The success callback immediately recreates this formation entity.
        // Publish the new clothing and skill levels BEFORE the acknowledgement.
        const before = { ...c, push: c.pushBefore }
        syncPlayer(before, { heros_info: c.state.player.heros_info })
        syncBattle(before)
        return {}
    })
    on('PinchFaceDataUp', (c, r) => {
        const basic = c.state.player.basic_info
        const wardrobe = { ...basic.wardrobe, ...r }
        ensure([1, 2].includes(wardrobe.sex), 'Invalid sex')
        // WardrobeInfo is also used by the later appearance editor. Optional
        // fields (notably height) are absent in the real CBT3 upload request.
        // Do not rerun character creation or reset the player's saved party.
        ensure(
            new Set(wardrobe.parts.map((part) => part.type)).size === wardrobe.parts.length,
            'Duplicate wardrobe part',
        )
        for (const part of wardrobe.parts)
            ensure(
                new Set(part.colors.map((color) => color.index)).size === part.colors.length,
                'Duplicate wardrobe color channel',
            )
        basic.wardrobe = wardrobe
        basic.sex = wardrobe.sex
        repairMainHeroType(c.tables, c.state)
        syncPlayer(c, { basic_info: basic, heros_info: c.state.player.heros_info })
        return {}
    })
    on('SkipGuide', (c, r) => {
        c.state.player.basic_info.skip_guide = r.u32 ?? 1
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('PlayerCustomData', (c, r) => {
        const b = c.state.player.basic_info
        if (r.name !== undefined) b.name = textValue(r.name, 15)
        if (r.wardrobe_info) {
            ensure([1, 2].includes(r.wardrobe_info.sex), 'Invalid sex')
            b.wardrobe = r.wardrobe_info
            b.sex = r.wardrobe_info.sex
        }
        c.state.characterCustomized = true
        initializeCharacterFormation(c.tables, c.state)
        repairMainHeroType(c.tables, c.state)
        syncPlayer(c, {
            basic_info: b,
            group_mgrs: c.state.player.group_mgrs,
            heros_info: c.state.player.heros_info,
        })
        return {}
    })
    on('ChangeName', (c, r) => {
        c.state.player.basic_info.name = textValue(r.name, 15)
        c.state.player.basic_info.last_change_name_time = c.now
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('ChangeSign', (c, r) => {
        c.state.player.basic_info.sign = textValue(r.sign, 255)
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('ChangeBirthday', (c, r) => {
        ensure(
            Number.isInteger(r.month) &&
                r.month >= 1 &&
                r.month <= 12 &&
                Number.isInteger(r.day) &&
                r.day >= 1 &&
                r.day <= new Date(Date.UTC(2024, r.month, 0)).getUTCDate(),
            'Invalid birthday',
        )
        c.state.player.basic_info.birthday = r
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('PlayerApparelInfoChange', (c, r) => {
        c.state.player.basic_info.apparel_info = r
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('PlayerClothesInfoChange', (c, r) => {
        ensureAppearance(c.tables, c.state)
        ensure(new Set(r.parts.map((part) => part.type)).size === r.parts.length, 'Duplicate clothing part')
        r = normalizeClothes(c.tables, r)
        for (const part of r.parts) {
            const clothing = appearanceCatalog(c.tables).clothes.get(part.id)
            ensure(clothing?.typeId === part.type, 'Clothing does not match its slot')
            ensure(c.state.unlockedClothes.includes(part.id), 'Clothing is not unlocked')
        }
        c.state.player.basic_info.clothes_info = r
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    for (const [name, field] of [
        ['SetSetting', 'settings'],
        ['SetHomeSetting', 'home_settings'],
    ])
        on(name, (c, r) => {
            c.state.player[field] = r
        })
    on('SetClientCustomOptions', (c, r) => {
        // CBT3 sends individual option updates, not a complete settings snapshot.
        // Keep unrelated keys and return the saved options in PlayerData on login.
        const entries = r.entries ?? []
        for (const entry of entries)
            ensure(
                typeof entry.key === 'string' && entry.key.length > 0 && typeof entry.val === 'string',
                'Invalid client custom option',
            )
        const options = new Map((c.state.player.custom_options?.entries ?? []).map((entry) => [entry.key, entry.val]))
        for (const entry of entries) options.set(entry.key, entry.val)
        c.state.player.custom_options = { entries: [...options].map(([key, val]) => ({ key, val })) }
    })
    on('GuideUpdate', (c, r) => {
        ensure(r.id > 0, 'Missing guide id')
        const a = c.state.player.guide_infos.infos
        const v = { id: r.id, sub_id: r.sub_id || 0, complete: true }
        const i = a.findIndex((g) => g.id === r.id)
        if (i < 0) a.push(v)
        else a[i] = v
        return v
    })
    on('RedPointSet', (c, r) => {
        c.state.flags[`red:${r.id}:${r.sub_id || 0}`] = !!r.flag
        return {}
    })
    on('WorldDifficultyRedPointSet', (c, r) => {
        c.state.flags.worldDifficultyRedPoints = r.u32s
        return {}
    })
    on('PlayerInfo', (c, r) => {
        const ids = r.player_ids?.length ? r.player_ids : [c.id]
        return { player_infos: ids.filter((id) => id === c.id).map(() => c.state.player.basic_info) }
    })
}
