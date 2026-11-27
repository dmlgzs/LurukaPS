import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { Tables } from '../src/player.js'
import { protocolCoverageStatus, protocolCoverageStatuses } from './protocol-coverage-status.js'
const c = configuration(),
    p = new Protocol(c.base),
    s = new Store(':memory:')
try {
    const g = new Game(p, s, new Tables(c.tables))
    const core = new Set([503, 504, 1001, 1002, 5001, 5002, 5004, 5007, 5009])
    const report = p.entries.map((e) => ({ ...e, status: protocolCoverageStatus(e, g.handlers, core) }))
    const output = process.env.LURUKAPS_COVERAGE_FILE
        ? path.resolve(process.env.LURUKAPS_COVERAGE_FILE)
        : fileURLToPath(new URL('../docs/coverage.json', import.meta.url))
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(
        Object.fromEntries(protocolCoverageStatuses.map((k) => [k, report.filter((e) => e.status === k).length])),
    )
    console.log('Registration metadata only; a schema does not prove a current C2S caller or working gameplay.')
} finally {
    s.close()
}
