import assert from 'node:assert/strict'
import { enemyDefinition } from '../src/enemy-state.js'
import { worldCondition } from '../src/handlers/world-objects.js'
import { parsePetGuid } from '../src/pet-guid.js'

export function captureCurrentWorldPet(f, driver, world, { objectId, petGroup }) {
    const { row, pos } = world.object(f.state().world.map_id, objectId)
    assert(worldCondition(row.appearCond, f.state()))
    assert(!row.disappearCond || !worldCondition(row.disappearCond, f.state()))
    const target = ((3n << 56n) | BigInt(row.id)).toString()
    const definition = enemyDefinition(f.tables, f.state(), target)
    assert.equal(definition.object_id, objectId)
    const enemy = f.tables.find('enemy', definition.config_id)
    const customized = f.tables.find('pet_customized', enemy.petId)
    const baseId = customized ? customized.petId : enemy.petId
    const rank = f.tables.get('pet_rank').find((value) => value.petId === baseId)
    assert.equal(rank?.petGroup, petGroup)
    driver.move(pos)
    const position = Object.fromEntries(Object.entries(pos).map(([axis, value]) => [axis, value / 100]))
    driver.call('GetCatchPetInfo', { tar_id: [target], day_weather: driver.currentDayWeather() })
    const specimen = structuredClone(f.state().petCatchPreviews[target].profile)
    assert.equal(specimen.config_id, baseId)
    const count = f.state().pets.length,
        cards = driver.cards()
    assert(cards > 0)
    const reserved = driver.reply(
        'CatchPetCard',
        driver.call('CatchPetCard', {
            client_param: String(objectId),
            item_id: 1000001,
            is_create: true,
        }),
    )
    assert.equal(driver.cards(), cards - 1)
    // SendRealTimeCatchPet0600efad marks the actual controlling entity dirty
    // and flushes StateUpdate immediately before10714. Re-send the same real
    // location through that RPC; no assumed Hero/Pet/FO24 actor field exists.
    driver.move(pos)
    const request = f.frame('CatchPet', {
        tar_id: target,
        item_id: 1000001,
        day_weather: driver.currentDayWeather(),
        position,
        catch_key: reserved.catch_key,
    })
    const caught = driver.reply('CatchPet', f.dispatch(request))
    assert.equal(caught.success, true)
    const pet = f.state().pets.find((value) => value.guid === caught.guid)
    assert(pet)
    assert.equal(pet.config_id, baseId)
    assert.equal(parsePetGuid(pet.guid).type, 2)
    assert.equal(f.state().pets.length, count + 1)
    assert.deepEqual(pet.gene_infos, specimen.gene_infos)
    assert.equal(driver.reply('CatchPet', f.dispatch(request)).guid, pet.guid)
    assert.equal(f.state().pets.length, count + 1)
    assert.equal(driver.cards(), cards - 1)
    driver.call('CatchPetPlayOver', { tar_id: target, day_weather: driver.currentDayWeather() })
    return {
        target,
        objectId,
        petGroup,
        baseId,
        guid: pet.guid,
        cardBefore: cards,
        cardAfter: driver.cards(),
        catchKey: reserved.catch_key,
        source: { row, enemyId: definition.config_id, packId: definition.pack_id },
        localGuaranteedCatchPolicy: true,
        opaqueClientParamPolicy: 'local-object-id-string-no-actor-authority',
        realPhysicsOrThrowAnimation: false,
    }
}
