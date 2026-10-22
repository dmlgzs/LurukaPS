import { chatShieldFixture } from './chat-shield-fixture.js'
export const showcaseFixture = (name, file) => chatShieldFixture('showcase-' + name, file)
export function sceneData(f, id = 1, who = f.a) {
    const state = f.state(who),
        hero = state.player.heros_info.heros.find((h) => h.type === 1)
    const pet = state.pets[0]
    const zero = { x: 0, y: 0, z: 0 }
    const content = {
        heroes: [
            JSON.stringify({
                heroConfigId: hero.conf_id,
                clothingId: hero.conf_id,
                pos: zero,
                rot: zero,
                actionId: 501,
                faceId: 601,
                actionTime: 0,
            }),
        ],
        pets: [
            JSON.stringify({
                petGuid: pet.guid,
                petConfigId: pet.config_id,
                specialParam: pet.color ?? 0,
                flashParam: [2, 3, 5].includes(pet.special ?? 0),
                starColorId: pet.colorful ?? 0,
                skinId: pet.wear_skin_id ?? 0,
                pos: zero,
                rot: zero,
                actionId: 1101,
                faceId: 1201,
                actionTime: 0,
            }),
        ],
        objs: [JSON.stringify({ configId: 1, pos: zero, rot: zero })],
        stamps: [JSON.stringify({ configId: 1, pos: { x: 0, y: 0 }, index: 1, scale: 1 })],
        camera: JSON.stringify({ pos: { x: 2.062012, y: 1.599, z: 3.042999 }, targetPos: { x: 0, y: 1, z: 0 } }),
        env: JSON.stringify({ configId: 1 }),
    }
    return { id, name: '我的情境', Cover: '', show_data: JSON.stringify(content) }
}
export function editScene(data, edit) {
    const content = JSON.parse(data.show_data)
    edit(content)
    return { ...data, show_data: JSON.stringify(content) }
}
export function editElement(data, list, edit) {
    return editScene(data, (content) => {
        const item = JSON.parse(content[list][0])
        edit(item)
        content[list][0] = JSON.stringify(item)
    })
}
