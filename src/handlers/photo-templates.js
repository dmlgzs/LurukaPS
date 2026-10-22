import { savePhotoTemplate, renamePhotoTemplate, deletePhotoTemplate } from '../photo-templates.js'

export function registerPhotoTemplates(on) {
    on('ChangePhotoGraphTempletInfo', savePhotoTemplate)
    on('ChangePhotoGraphTempletName', renamePhotoTemplate)
    on('DeletePhotoGraphTemplet', deletePhotoTemplate)
}
