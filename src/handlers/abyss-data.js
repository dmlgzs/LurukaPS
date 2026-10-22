import { abyssDataSnapshot } from '../abyss-data.js'
export function registerAbyssData(on, tables) {
    on('AbyssData', (c) => abyssDataSnapshot(tables, c.state, c.now))
}
