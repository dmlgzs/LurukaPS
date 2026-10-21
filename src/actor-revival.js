import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { u64, combatState } from './combat-state.js'
import { heroModules, heroBattleLimits, petModules } from './battle.js'
import { temporaryHeroes, temporaryPets, isRetiredTrialActor } from './trial-actors.js'

export function reviveFriendlyActor(c, request) {
    ensure(typeof request.hero_uuid !== 'number' || Number.isSafeInteger(request.hero_uuid), 'Unsafe revival identity')
    const id = u64(request.hero_uuid)
    ensure(id !== '0', 'Missing revival actor')
    if (isRetiredTrialActor(c.state, id)) return
    const heroes = [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)]
    const hero = heroes.find((value) => value.guid === id)
    const pet = [...c.state.pets, ...temporaryPets(c.state)].find((value) => value.guid === id)
    const kind = Number(BigInt(id) >> 56n)
    ensure(
        hero || pet,
        'Revival actor is not owned or active',
        [2, 9].includes(kind) ? ErrorCode.PetNotExist : ErrorCode.HeroNotExist,
    )
    ensure(
        Number.isSafeInteger(request.revive_val) && request.revive_val > 0 && request.revive_val <= 0xffffffff,
        'Invalid revival HP value',
    )
    const currentBattle = c.state.combat?.map_id === c.state.world.map_id ? c.state.combat : null
    ensure(
        !pet || !currentBattle?.npcDuel?.actors?.[id],
        'Arena contestant revival requires authoritative battle support',
        ErrorCode.FunctionClosed,
    )
    const modules = hero
        ? heroModules(c.tables, c.state, hero)
        : petModules(
              c.tables,
              c.state,
              pet,
              heroes
                  .filter((value) => value.guid === pet.hero_id)
                  .map((value) => heroModules(c.tables, c.state, value)),
          )
    const max = heroBattleLimits(modules)
    const saved = hero
        ? c.state.player.heros_info.battle_infos.find((value) => value.hero_id === id)
        : currentBattle?.entities?.[id]
    ensure(!hero || saved, 'Hero battle state is unavailable', ErrorCode.GameConfig)
    const hp = saved?.hp ?? max.hp,
        alive = saved?.alive_state ?? (hp > 0 ? 0 : 1)
    ensure(
        Number.isSafeInteger(hp) && hp >= 0 && Number.isSafeInteger(alive) && alive >= 0 && alive <= 2,
        'Invalid saved revival state',
        ErrorCode.GameConfig,
    )
    // ReviveElement sends FormulaUtility.Calculate(...).MyFloat.ToInt(). It is
    // actual HP, not basis points or the WORLD_HERO_REBORN_HP percentage.
    // A repeated report on an already live actor is a resync, never a heal.
    const restored = hp === 0 || alive !== 0 ? Math.min(request.revive_val, max.hp) : Math.min(hp, max.hp)
    if (hero) {
        saved.hp = restored
        saved.alive_state = 0
        if (Object.hasOwn(saved, 'rescue_val')) saved.rescue_val = 0
        delete saved.final_blow_guid
        if (currentBattle?.entities?.[id])
            currentBattle.entities[id] = {
                ...currentBattle.entities[id],
                hp: restored,
                max_hp: max.hp,
                alive_state: 0,
                rescue_val: 0,
                final_blow_guid: '0',
                updated_at: c.now,
            }
    } else {
        const battle = combatState(c.state, c.now)
        battle.entities[id] = {
            ...saved,
            uuid: id,
            hp: restored,
            max_hp: max.hp,
            alive_state: 0,
            rescue_val: 0,
            final_blow_guid: '0',
            updated_at: c.now,
        }
    }
    // SP is deliberately absent: this effect changes HP and alive state only.
    c.pushBefore('CSProtoObjBattleInfoSync', {
        infos: [{ uuid: id, hp: restored, alive_state: 0, rescue_val: 0, final_blow_guid: '0', reason: 0 }],
    })
}
