import { heroTrialSoulEssence } from './trial-equipment.js'
import { soulEssenceGrade } from './equipment.js'
import { soulSkillsAtGrade } from './skills.js'
// CBT3 client evidence: ui_configtpl_herotpl.lua:getHeroConfigAtt;
// ui_store_hero_data_heroattrmoduleinfo.lua:addSub; const.lua:SpecialAttList.
const specialAttributes = new Set([1, 3, 5, 201, 229, 230])
export function pairs(value) {
    const result = new Map()
    if (!value) return result
    for (const item of String(value).split('|')) {
        const [id, text, ...extra] = item.split('#')
        if (text === '') continue // Empty values are present in the extracted template tables.
        const key = Number(id),
            number = Number(text)
        if (extra.length || !Number.isInteger(key) || key <= 0 || text === undefined || !Number.isFinite(number))
            throw Error(`Invalid attribute pair ${item}`)
        result.set(key, number)
    }
    return result
}
function requireRow(tables, name, id) {
    const r = tables.find(name, id)
    if (!r) throw Error(`Missing ${name} row ${id}`)
    return r
}
function wireAttributes(map) {
    return [...map]
        .sort((a, b) => a[0] - b[0])
        .map(([attr_id, n]) => {
            const value = Math.trunc(n)
            if (!Number.isSafeInteger(value)) throw Error(`Attribute ${attr_id} exceeds exact numeric range`)
            return { attr_id, attr_val: String(value) }
        })
}
export function heroBattleConfig(tables, hero) {
    const clothing = tables.get('hero_clothing').find((row) => row.clothingid === (hero.hero_skin || hero.conf_id))
    return clothing && requireRow(tables, 'hero_battle_info', clothing.battleInfo)
}
function heroSkills(tables, config, hero) {
    const battleInfo = heroBattleConfig(tables, hero)
    const selected = battleInfo || config
    const skills = new Map()
    const system = String(config.skillSystem || '')
        .split('|')
        .map(Number)
    const add = (id, slot = 0) => {
        if (!id) return
        // CBT3 HeroSkinHelper.IsSkinnedSkill maps battleInfo*100+suffix
        // back to the base hero skill. Skin variants share its upgrade level.
        const canonical =
            battleInfo && Math.floor(id / 100) === battleInfo.id
                ? Math.floor(battleInfo.id / 100) * 100 + (id % 100)
                : id
        const index = system.indexOf(canonical)
        skills.set(`${slot}:${id}`, {
            skill_id: id,
            skill_lv: index < 0 ? 1 : hero.system_skill_levels[index] || 1,
            skill_slot: slot,
            type: 0,
        })
    }
    add(selected.attackSkill, 1)
    for (const field of ['skillList', 'aerialSkillList']) for (const [slot, id] of pairs(selected[field])) add(id, slot)
    for (const field of ['passiveSkillList', 'backupSkillList'])
        for (const id of String(selected[field] || '')
            .split('|')
            .filter(Boolean)
            .map(Number))
            add(id)
    // Home skills belong to the selected clothing's battle info. The avatar
    // hero rows cross-reference the opposite sex's home skills in CBT3.
    for (const id of String(battleInfo?.homeSkillList || '')
        .split('|')
        .filter(Boolean)
        .map(Number))
        add(id)
    for (const skill of [...skills.values()]) {
        if (battleInfo && Math.floor(skill.skill_id / 100) === battleInfo.id) {
            const canonical = Math.floor(battleInfo.id / 100) * 100 + (skill.skill_id % 100)
            if (![...skills.values()].some((entry) => entry.skill_id === canonical)) add(canonical)
        }
    }
    return [...skills.values()]
}
export function heroModules(tables, state, hero) {
    const config = requireRow(tables, 'hero', hero.conf_id)
    const property = requireRow(tables, 'unit_property', config.propertyId)
    // CBT3 Lua selects template_hero by level; rank is not part of that lookup.
    const growth = requireRow(tables, 'template_hero', hero.hero_lv)
    const factors = pairs(requireRow(tables, 'template_value', property.baseAttributeId).baseAttribute)
    const base = pairs(requireRow(tables, 'template_value', growth.baseAttribute).baseAttribute)
    const attributes = new Map()
    for (const [id, value] of base) if (factors.has(id)) attributes.set(id, value * factors.get(id))
    const modules = [
        {
            module_type: 0,
            sub_modules: [
                {
                    sub_module_id: 0,
                    attrs: { attrs: wireAttributes(attributes) },
                    skills: { skills: heroSkills(tables, config, hero) },
                },
            ],
        },
    ]
    const soul = hero.trail
        ? heroTrialSoulEssence(tables, hero)
        : state.player.soulessence_infos.soulessences.find((x) => x.guid === hero.wguid)
    const soulAttributes = new Map(),
        soulSkills = []
    if (soul) {
        const cfg = requireRow(tables, 'soulessence', soul.id)
        const value = requireRow(tables, 'soulessence_value', cfg.attribute * 1000 + soul.lv)
        const rank = tables.get('soulessence_rank').find((r) => r.relatedId === soul.id && r.rank === soul.rank)
        if (!rank) throw Error(`Missing soul essence rank ${soul.id}:${soul.rank}`)
        for (const field of [value.baseAttribute, rank.rankUpAttributeAll])
            for (const [id, n] of pairs(field))
                soulAttributes.set(id, (soulAttributes.get(id) || 0) + n * (specialAttributes.has(id) ? 10000 : 1))
        soulSkills.push(...soulSkillsAtGrade(tables, soul.id, soulEssenceGrade(soul)))
    }
    // Always replace submodule zero, including after unequip, to clear cached client bonuses.
    modules.push({
        module_type: 1,
        sub_modules: [
            { sub_module_id: 0, attrs: { attrs: wireAttributes(soulAttributes) }, skills: { skills: soulSkills } },
        ],
    })
    return { hero_guid: hero.guid, hero_conf_id: hero.conf_id, type: hero.trail ? 5 : 1, modules }
}
// HeroUtility.PackAttrInfoValue divides SpecialAttList values by 10000.
// Attribute modules retain fixed-point values; battle HP uses whole points.
export function heroBattleLimits(info) {
    const attrs = new Map()
    for (const module of info.modules)
        for (const sub of module.sub_modules)
            for (const attr of sub.attrs.attrs)
                attrs.set(attr.attr_id, (attrs.get(attr.attr_id) || 0) + Number(attr.attr_val))
    const hp = Math.floor(
            ((attrs.get(5) || 0) / 10000) * (1 + (attrs.get(1005) || 0) / 10000) + (attrs.get(2005) || 0),
        ),
        sp = Math.floor(attrs.get(6) || 0)
    if (
        !Number.isSafeInteger(hp) ||
        hp <= 0 ||
        hp > 0xffffffff ||
        !Number.isSafeInteger(sp) ||
        sp < 0 ||
        sp > 0xffffffff
    )
        throw Error(`Invalid battle limits for ${info.hero_conf_id}`)
    return { hp, sp }
}
export function refreshBattleState(tables, state) {
    const heros = [...state.player.heros_info.heros, ...(state.trialGroup?.heroes ?? [])].map((hero) =>
        heroModules(tables, state, hero),
    )
    const previous = new Map((state.player.heros_info.battle_infos || []).map((x) => [x.hero_id, x]))
    state.player.heros_info.battle_infos = heros.map((h) => {
        const { hp: maxhp, sp: maxsp } = heroBattleLimits(h)
        const old = previous.get(h.hero_guid)
        const oldHp =
            old && !state.battleHpUnitsVersion && old.hp > maxhp ? Math.max(1, Math.floor(old.hp / 10000)) : old?.hp
        const hp = old ? Math.min(oldHp, maxhp) : maxhp,
            sp = old ? Math.min(old.sp, maxsp) : maxsp
        return { ...old, hero_id: h.hero_guid, hp, sp, alive_state: hp > 0 ? 0 : 1 }
    })
    state.battleHpUnitsVersion = 1
    return heros
}
export function syncBattle(c) {
    if (c.state.combat) {
        delete c.state.combat.energyActorKey
        delete c.state.combat.energySpecs
    }
    const heros = refreshBattleState(c.tables, c.state)
    const pets = [...c.state.pets, ...(c.state.trialGroup?.pets ?? [])]
        .filter((p) => c.tables.find('template_value', p.config_id))
        .map((p) => petModules(c.tables, c.state, p, heros))
    c.push('CSProtoHeroAttrInfoSync', { heros: [...heros, ...pets] })
    const active = c.state.player.group_mgrs.find((manager) => manager.type === 1),
        formation = active?.groups.find((entry) => entry.id === active.cur_group),
        heroIds = new Set((formation?.heros ?? []).map((entry) => entry.hero_id)),
        petSp = c.state.combat?.map_id === c.state.world.map_id ? (c.state.combat.petSp ?? {}) : {}
    c.push('CSProtoObjBattleInfoSync', {
        infos: [
            ...c.state.player.heros_info.battle_infos.map((h) => ({
                uuid: h.hero_id,
                hp: h.hp,
                sp: h.sp,
                alive_state: h.alive_state,
                reason: 1,
            })),
            ...[...c.state.pets, ...(c.state.trialGroup?.pets ?? [])]
                .filter((pet) => heroIds.has(pet.hero_id))
                .map((pet) => ({ uuid: pet.guid, sp: petSp[pet.guid] ?? 0, reason: 1 })),
        ],
    })
}

export function petModules(tables, state, pet, heroes) {
    const baseRow = requireRow(tables, 'template_value', pet.config_id)
    const growth = requireRow(tables, 'template_value', 5001000 + pet.lv)
    const factors = pairs(growth.baseAttribute),
        base = pairs(baseRow.baseAttribute),
        attrs = new Map()
    for (const [id, n] of base) if (factors.has(id)) attrs.set(id, n * factors.get(id))
    const hobby = pairs(requireRow(tables, 'pet_hobby', pet.feature || 1).baseAttribute)
    const info = new Map(tables.get('battle_info').map((r) => [r.attrVal, r]))
    const groups = new Map()
    for (const row of info.values())
        if (row.attrGroup) {
            const [id, index] = row.attrGroup.split('|').map(Number)
            if (!groups.has(id)) groups.set(id, [])
            groups.get(id)[index - 1] = row.attrVal
        }
    for (const row of tables.get('pet_learningenum')) {
        const id = row.attributeEnum,
            n = attrs.get(id) || 0
        const aptitude = (pet.comprehension || []).find((a) => a.attr_id === id)?.value ?? 100
        const value =
            info.get(id)?.isRatio === 1
                ? n + (hobby.get(id) || 0) + aptitude
                : (((n * (hobby.get(id) ?? 100)) / 100) * aptitude) / 100
        attrs.set(id, value)
    }
    const hero = heroes.find((h) => h.hero_guid === pet.hero_id)
    if (hero) {
        const favor = tables.get('pet_favorability').find((r) => r.level === (pet.favor_lv || 1))
        if (!favor) throw Error('Missing pet favor level')
        const heroAttrs = new Map()
        for (const m of hero.modules)
            for (const s of m.sub_modules)
                for (const a of s.attrs.attrs)
                    heroAttrs.set(a.attr_id, (heroAttrs.get(a.attr_id) || 0) + Number(a.attr_val))
        for (const row of tables.get('pet_attributeinheritance')) {
            const ids = groups.get(row.attrVal)
            if (ids && ids[0] !== row.attrVal) continue // Extras are combined with their base once.
            const [id, percentId, extraId] = ids || [row.attrVal]
            const scale = specialAttributes.has(id) ? 10000 : 1
            const raw =
                (heroAttrs.get(id) || 0) * (1 + (heroAttrs.get(percentId) || 0) / 10000) + (heroAttrs.get(extraId) || 0)
            const display = id === 5 ? Math.floor(raw / scale) : Math.round(raw / scale)
            const extraAdjustment =
                tables.get('pet_attributeinheritance').find((x) => x.attrVal === extraId)?.adjustment || 0
            const inherited =
                Math.floor(((display + row.adjustment + extraAdjustment) * favor.levelEffect) / 10000) * scale
            attrs.set(row.petAttrVal, (attrs.get(row.petAttrVal) || 0) + inherited)
        }
    }
    return {
        hero_guid: pet.guid,
        hero_conf_id: pet.config_id,
        type: pet.type === 2 ? 9 : 2,
        modules: [
            {
                module_type: 4,
                sub_modules: [
                    {
                        sub_module_id: 0,
                        attrs: { attrs: wireAttributes(attrs) },
                        skills: { skills: pet.inherent_skills || [] },
                    },
                ],
            },
            { module_type: 5, sub_modules: [{ sub_module_id: 0, attrs: { attrs: [] }, skills: { skills: [] } }] },
        ],
    }
}
