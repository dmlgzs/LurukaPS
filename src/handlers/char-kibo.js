import { claimCharKibo } from '../char-kibo.js'

export function registerCharKibo(on) {
    on('PetGetCharKibo', (c, request) => claimCharKibo(c.tables, c.state, request, c.now))
}
