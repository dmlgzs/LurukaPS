import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { gridPosition } from './home-grid.js'

// CBT3 HomeModule_Interact.UpdateSelectGridOfCurSelectSeed divides the
// configured footprint by two: follower GUIDs reserve cells for ONE seed.
export function cropFootprint(home, root, config, followerGuids, seen) {
    const size = String(config.homeItemSize).split('|').map(Number)
    ensure(
        size.length === 2 && size.every((n) => Number.isInteger(n) && n > 0 && n % 2 === 0),
        'Invalid crop footprint configuration',
        ErrorCode.GameConfig,
    )
    const guids = [root.guid, ...(followerGuids ?? [])]
    ensure(
        guids.length === (size[0] * size[1]) / 4,
        'Crop footprint does not match its fields',
        ErrorCode.InvalidArgument,
    )
    const cells = guids.map((guid) => {
        ensure(
            Number.isInteger(guid) && guid > 0 && !seen.has(guid),
            'Duplicate or invalid planting field',
            ErrorCode.InvalidArgument,
        )
        seen.add(guid)
        const build = home.builds.find((b) => b.guid === guid)
        ensure(
            build?.crop_info && build.locate && build.status === 1,
            'Farmland is not owned/ready',
            ErrorCode.HomeFieldNotOpen,
        )
        ensure(
            build.build_id === root.build_id &&
                build.crop_info.field_type === root.crop_info.field_type &&
                build.locate.block_id === root.locate.block_id,
            'Crop fields are not of the same type and block',
            ErrorCode.HomeFieldTypeDismatch,
        )
        ensure(
            !build.crop_info.seed_id &&
                !build.crop_info.main_build_guid &&
                !build.crop_info.follower_build_guids?.length,
            'Farmland already has a crop',
            ErrorCode.HomeFieldHasCrop,
        )
        return { build, ...gridPosition(build.locate.anchor) }
    })
    const xs = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b)
    const ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b)
    ensure(
        ((xs.length === size[0] / 2 && ys.length === size[1] / 2) ||
            (xs.length === size[1] / 2 && ys.length === size[0] / 2)) &&
            xs.every((x, i) => !i || x - xs[i - 1] === 2) &&
            ys.every((y, i) => !i || y - ys[i - 1] === 2) &&
            new Set(cells.map((c) => `${c.x}:${c.y}`)).size === cells.length,
        'Crop fields must form the configured continuous footprint',
        ErrorCode.InvalidArgument,
    )
    return cells.map((c) => c.build)
}

export function linkedCropFields(home, root) {
    const guids = root.crop_info.follower_build_guids ?? []
    return [
        root,
        ...guids.map((guid) => {
            const build = home.builds.find((b) => b.guid === guid)
            ensure(
                build?.crop_info?.main_build_guid === root.guid && !build.crop_info.seed_id,
                'Broken crop field association',
                ErrorCode.GameConfig,
            )
            return build
        }),
    ]
}
