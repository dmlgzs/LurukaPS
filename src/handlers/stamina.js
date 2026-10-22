import { prepareStamina, staminaAttributes } from '../stamina.js'
export function registerStamina(on) {
    on('StaminaSync', (c) => {
        prepareStamina(c.tables, c.state, c.now)
        c.pushBefore('CSProtoSyncPlayerData', { attr_infos: { attrs: staminaAttributes(c.state) } })
        return {}
    })
}
