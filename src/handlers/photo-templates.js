import { savePhotoTemplate, renamePhotoTemplate } from '../photo-templates.js'

export function registerPhotoTemplates(on) {
    on('ChangePhotoGraphTempletInfo', savePhotoTemplate)
    on('ChangePhotoGraphTempletName', renamePhotoTemplate)
}
