import { changeItemShortcut } from '../shortcuts.js'

export function registerShortcuts(on) {
    on('ShortcutKeySet', changeItemShortcut)
}
