import { operateSnackBag } from '../snack-bags.js'
export function registerSnackBags(on) {
    on('OperateSnackBag', operateSnackBag)
}
