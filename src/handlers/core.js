import { syncBattle } from '../battle.js'
import { mergeHomeSettings } from '../home-settings.js'
import { ensure, textValue, syncPlayer, hero } from './common.js'
import { ensureAppearance, appearanceCatalog, normalizeClothes } from '../appearance.js'
import { initializeCharacterFormation } from '../character-creation.js'
import { repairMainHeroType } from '../main-hero.js'
import { mergeWardrobeInfo } from '../appearance-wardrobe.js'
import { selectNormalStarterAvatar } from '../normal-starter-avatar.js'
import { recordGuideStep, setGuideSkipChoice } from '../guide-progress.js'
import { planPlayerRename, validatePlayerSignBytes, validatePlayerNameBytes } from '../player-text.js'
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
        // Current SaveAsPreset success immediately refreshes the per-sex
        // ModStore dictionary and thumbnail keys before returning from ACK.
        c.pushBefore('SCProtoPresetWardrobeSync', { info_list: presets })
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
        const wardrobe = mergeWardrobeInfo(basic.wardrobe, r)
        const avatar = selectNormalStarterAvatar(c.tables, c.state, wardrobe.sex)
        basic.wardrobe = wardrobe
        basic.sex = wardrobe.sex
        repairMainHeroType(c.tables, c.state)
        // The successful editor callback recreates the default hero immediately.
        if (avatar) ensureAppearance(c.tables, c.state)
        const before = { ...c, push: c.pushBefore }
        syncPlayer(before, { basic_info: basic, heros_info: c.state.player.heros_info })
        if (avatar?.changed) syncBattle(before)
        return {}
    })
    on('SkipGuide', (c, r) => {
        setGuideSkipChoice(c.state, r.u32, c.now)
        syncPlayer(c, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('PlayerCustomData', (c, r) => {
        const avatar = selectNormalStarterAvatar(
            c.tables,
            c.state,
            r.wardrobe_info?.sex ?? c.state.player.basic_info.sex,
        )
        const b = c.state.player.basic_info
        const initialName = avatar !== null && c.state.characterCustomized !== true
        if (r.name !== undefined || initialName)
            b.name = validatePlayerNameBytes(c.tables, r.name, {
                initial: initialName,
            })
        if (r.wardrobe_info) {
            ensure([1, 2].includes(r.wardrobe_info.sex), 'Invalid sex')
            b.wardrobe = r.wardrobe_info
            b.sex = r.wardrobe_info.sex
        }
        c.state.characterCustomized = true
        initializeCharacterFormation(c.tables, c.state)
        repairMainHeroType(c.tables, c.state)
        if (avatar) ensureAppearance(c.tables, c.state)
        const target = avatar ? { ...c, push: c.pushBefore } : c
        syncPlayer(target, {
            basic_info: b,
            group_mgrs: c.state.player.group_mgrs,
            heros_info: c.state.player.heros_info,
        })
        if (avatar?.changed || avatar?.initialized) syncBattle(target)
        return {}
    })
    on('ChangeName', (c, r) => {
        const plan = planPlayerRename(c.tables, c.state, r, c.now)
        if (plan === null) return {}
        Object.assign(c.state.player.basic_info, plan)
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: c.state.player.basic_info })
        return {}
    })
    on('ChangeSign', (c, r) => {
        c.state.player.basic_info.sign = validatePlayerSignBytes(c.tables, r.sign)
        syncPlayer({ ...c, push: c.pushBefore }, { basic_info: c.state.player.basic_info })
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
    on('SetSetting', (c, r) => {
        c.state.player.settings = r
    })
    on('SetHomeSetting', (c, r) => {
        c.state.player.home_settings = mergeHomeSettings(c.state.player.home_settings, r)
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
    on('GuideUpdate', (c, r) => recordGuideStep(c.tables, c.state, r))
    on('RedPointSet', (c, r) => {
        c.state.flags[`red:${r.id}:${r.sub_id || 0}`] = !!r.flag
        return {}
    })
}
