import { petData } from './pets.js'
import { mainHeroConfigId } from './main-hero.js'
import fs from 'node:fs'
import path from 'node:path'
export const bytes = (text) => Buffer.from(text, 'utf8').toString('base64')
export const heroData = (configId, accountId, type = 0) => ({
    guid: ((1n << 56n) | (BigInt(configId) << 32n) | BigInt(accountId)).toString(),
    conf_id: configId,
    hero_lv: 1,
    hero_exp: 0,
    hero_rank: 1,
    hero_star: 0,
    hero_grade: 1,
    system_skill_levels: [1, 1, 1, 1, 1, 1],
    type,
    favorability_lv: 1,
    trial_pet: '0',
    pet_id: '0',
    wguid: 0,
})
export class Tables {
    constructor(dir) {
        this.dir = dir
        this.cache = new Map()
        this.indices = new Map()
    }
    get(name) {
        if (!this.cache.has(name)) {
            const rows = JSON.parse(fs.readFileSync(path.join(this.dir, `${name}.json`), 'utf8'))
            if (!Array.isArray(rows)) throw Error(`Invalid table ${name}`)
            this.cache.set(name, rows)
        }
        return this.cache.get(name)
    }
    find(name, id) {
        if (!this.indices.has(name)) this.indices.set(name, new Map(this.get(name).map((x) => [x.id, x])))
        return this.indices.get(name).get(Number(id))
    }
    position(point) {
        const values = String(point.borthPoint).split('|').map(Number)
        if (values.length !== 6 || values.some((x) => !Number.isFinite(x)))
            throw Error(`Invalid borthPoint ${point.id}`)
        const homeMapId = Number(this.get('game').find((row) => row.title === 'HOME_ID')?.value)
        const homeArea =
            point.cityId === homeMapId ? this.get('world_area').find((row) => row.sceneId === homeMapId) : null
        if (point.cityId === homeMapId && !homeArea) throw Error(`Missing home world area ${homeMapId}`)
        return {
            map_id: point.cityId,
            point_id: point.id,
            pos: { x: Math.trunc(values[0] * 100), y: Math.trunc(values[1] * 100), z: Math.trunc(values[2] * 100) },
            angle: Math.trunc(values[4]),
            area_id: point.cityId === 100 ? 100004 : (homeArea?.id ?? 0),
        }
    }
}
export function seedPlayer(tables, id, openId) {
    const mainId = mainHeroConfigId(tables, 2)
    const heroes = tables
        .get('hero')
        .filter((h) => h.isUsable === 1)
        .map((h) => heroData(h.id, id, h.id === mainId ? 1 : 0))
    if (!heroes.length) throw Error('No usable heroes in table')
    const pets = tables
        .get('pet')
        .filter((p) => p.petStage > 0 && p.IsCatch === 1 && tables.find('template_value', p.id))
        .map((p, i) => petData(tables, p.id, String(p.id), (Math.floor(i / 30) + 1) * 100 + (i % 30) + 1))
    const essences = tables
        .get('soulessence')
        .map((e) => ({ guid: e.id, id: e.id, lv: 1, rank: 1, advance: 1, exp: 0, lock: true, wear_hero: '0' }))
    const placeholder = heroes[0]
    const groups = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        group_name: bytes(`队伍${i + 1}`),
        heros: Array.from({ length: 3 }, () => ({ hero_id: '0', pet_id: '0' })),
        control: '0',
    }))
    groups[0].heros[0].hero_id = placeholder.guid
    groups[0].control = placeholder.guid
    const birth = tables.find('world_borthpos', 10045) || tables.get('world_borthpos')[0]
    return {
        schema: 1,
        player: {
            basic_info: {
                id,
                zone_id: 1,
                name: bytes('&AzurPlayer'),
                sex: 2,
                lv: 1,
                sign: 'THVydWthUFMg5piv5YWN6LS555qE77yM5LuF5L6b5a2m5Lmg56CU56m25Y2P6K6u5a6e546w77yM5Lil56aB55So5LqO5ZWG5Lia55So6YCU44CCTHVydWthUFMgaXMgZnJlZSBhbmQgaW50ZW5kZWQgZm9yIGxlYXJuaW5nIGFuZCBwcm90b2NvbCByZXNlYXJjaCBvbmx5OyBjb21tZXJjaWFsIHVzZSBpcyBwcm9oaWJpdGVkLg==',
                gold: 0,
                diamond: 0,
                exp: 0,
                account: bytes(openId),
                regtm: Math.floor(Date.now() / 1000),
                home_lv: 1,
                wardrobe: { sex: 2, height: 90, complexion: 0 },
                info: {},
                detail_info: {},
                lend_info: { can_lend_num: 0, last_lend_time: 0 },
                language: 1,
                birthday: { month: 1, day: 1 },
                is_created: true,
                skip_guide: 1,
                nest_guide_finish: 1,
                apparel_info: {},
                clothes_info: {},
            },
            heros_info: { heros: heroes, battle_infos: [] },
            sbag_infos: { items: [] },
            attr_infos: { attrs: [] },
            soulessence_infos: { soulessences: essences },
            group_mgrs: [
                { type: 1, cur_group: 1, last_group: 1, src: 0, groups },
                { type: 6, cur_group: 1, last_group: 1, src: 0, groups: [] },
            ],
            guide_infos: { infos: [] },
            settings: { entries: [] },
            home_settings: { entries: [] },
            custom_options: { entries: [] },
        },
        pets,
        recordPets: [],
        petCatalogVersion: 2,
        petBoxes: Array.from({ length: Math.ceil(pets.length / 30) }, (_, i) => ({
            id: i + 1,
            box_name: bytes(`奇波小屋${i + 1}`),
        })),
        world: {
            ...tables.position(birth),
            weather: 1,
            mount: '0',
            points: tables.get('world_borthpos').map((p) => p.id),
        },
        mail: [],
        tasks: [],
        claims: [],
        flags: {},
    }
}
