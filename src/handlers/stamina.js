import { prepareStamina, staminaAttributes } from '../stamina.js'
import { buyStamina } from '../stamina-purchase.js'
export function registerStamina(on) {
    on('BuyStamina', buyStamina)
    on('StaminaSync', (c) => {
        prepareStamina(c.tables, c.state, c.now)
        c.pushBefore('CSProtoSyncPlayerData', { attr_infos: { attrs: staminaAttributes(c.state) } })
        return {}
    })
}
