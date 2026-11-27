import { getCultTrialGroup } from '../cult-trial-query.js'
export function registerCultTrialQuery(on) {
    on('GetTrialGroup', getCultTrialGroup)
}
