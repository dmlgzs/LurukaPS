import { savePhotoTemplate } from '../photo-templates.js'

export function registerPhotoTemplates(on) {
    on('ChangePhotoGraphTempletInfo', savePhotoTemplate)
}
