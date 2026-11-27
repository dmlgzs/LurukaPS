import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentSunyaMilestone } from './next106013-sunya-runner.js'

test('current106013 genuine561 startup, city exit and two-wave Sunya reach memory entry with full request tracing', async () => {
    const base = process.env.NORMAL_106013_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-next106013-'))
    await runCurrentSunyaMilestone({ artifacts: path.join(base, 'sunya') })
})
