import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { cropFootprint, linkedCropFields } from './crop-footprint.js'
import { gridPosition, validatePlacement } from './home-grid.js'

export function transplantCrop(tables, state, request) {
    const home = state.home,
        row = request.main_build
    ensure(row?.locate, 'Missing transplant position', ErrorCode.InvalidArgument)
    const root = home.builds.find((b) => b.guid === row.guid)
    ensure(
        root?.crop_info && tables.get('home_fieldtype').some((r) => r.homeBuildingId === root.build_id),
        'Farmland is not owned',
        ErrorCode.HomeFieldNotOpen,
    )
    ensure(
        !root.crop_info.main_build_guid || root.crop_info.main_build_guid === root.guid,
        'A follower field cannot be transplanted separately',
        ErrorCode.InvalidArgument,
    )
    const fields = linkedCropFields(home, root),
        requests = [row, ...(request.follower_builds ?? [])]
    const byGuid = new Map(requests.map((r) => [r.guid, r]))
    ensure(
        requests.length === fields.length && byGuid.size === fields.length && fields.every((b) => byGuid.has(b.guid)),
        'Transplant must include exactly the linked crop fields',
        ErrorCode.InvalidArgument,
    )
    const moved = new Map(
        fields.map((build) => {
            ensure(!build.crop_info.is_fixed, 'Fixed field cannot be moved', ErrorCode.FixedFieldCanNotMove)
            const locate = byGuid.get(build.guid).locate
            ensure(locate, 'Missing transplant field position', ErrorCode.InvalidArgument)
            return [build.guid, { ...build, locate: { ...locate, direction: locate.direction ?? 0 } }]
        }),
    )
    // Validate against the final arrangement. Checking one move against the
    // old arrangement rejects legal whole-footprint translations/rotations.
    const nextHome = { ...home, builds: home.builds.map((b) => moved.get(b.guid) ?? b) }
    const projected = { ...state, home: nextHome }
    for (const build of moved.values())
        validatePlacement(tables, projected, build.build_id, build.locate, build.guid, { checkLimit: false })
    if (fields.length > 1) {
        const config = tables.find('home_seeds', root.crop_info.seed_id)
        ensure(config, 'Missing planted crop configuration', ErrorCode.HomeSeedIdNotInSeedConf)
        cropFootprint(nextHome, moved.get(root.guid), config, root.crop_info.follower_build_guids, new Set(), root.guid)
        const oldRoot = gridPosition(root.locate.anchor),
            newRoot = gridPosition(moved.get(root.guid).locate.anchor)
        const vectors = fields.map((b) => {
            const old = gridPosition(b.locate.anchor),
                next = gridPosition(moved.get(b.guid).locate.anchor)
            return { x: old.x - oldRoot.x, y: old.y - oldRoot.y, nx: next.x - newRoot.x, ny: next.y - newRoot.y }
        })
        ensure(
            [0, 1, 2, 3].some((turn) =>
                vectors.every(({ x, y, nx, ny }) => {
                    for (let i = 0; i < turn; i++) [x, y] = [-y, x]
                    return x === nx && y === ny
                }),
            ),
            'Transplant cannot rearrange linked field identities',
            ErrorCode.InvalidArgument,
        )
    }
    for (const build of fields) build.locate = moved.get(build.guid).locate
    state.homeRevision = (state.homeRevision ?? 0) + 1
}
