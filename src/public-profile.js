export const profileKeys = [
    'id',
    'zone_id',
    'name',
    'sex',
    'lv',
    'wardrobe',
    'sign',
    'home_lv',
    'language',
    'preffix_title',
    'suffix_title',
    'little_avatar',
    'apparel_info',
    'clothes_info',
    'skin_id',
    'info',
    'stand_plates',
    'scene_showcase',
    'show_case',
    'show_case_id',
]
export function publicProfile(basic) {
    return Object.fromEntries(profileKeys.filter((key) => basic[key] !== undefined).map((key) => [key, basic[key]]))
}
