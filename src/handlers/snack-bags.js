import { operateSnackBag, setSnackBagNum } from '../snack-bags.js'
export function registerSnackBags(on) {
    on('OperateSnackBag', operateSnackBag)
    on('SetSnackBagNum', setSnackBagNum)
}
