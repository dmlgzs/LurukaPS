import { currentMapMember } from './current-map-member.js'
// Current CreateCTeam060015e7 uses the current formation's control/positions;
// its public pet data explicitly carries configId/color. No owned GUID leaves.
export function teamV2MemberData(state, playerId) {
    return currentMapMember(state, playerId).data
}
