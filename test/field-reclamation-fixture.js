import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { gridAnchor, validatePlacement } from '../src/home-grid.js'

export function reclamationFixture(name, filename = ':memory:', resume = false) {
    const f = farmHarvestFixture(name, filename, { resume })
    const fields = f.tables.get('home_fieldtype')
    const primary = f.field(100),
        fieldType = fields.find((row) => row.id === primary.crop_info.field_type)
    const block = f.tables.find('home_block', primary.locate.block_id)
    const start = String(block.blockStartPos).split('|').map(Number),
        end = String(block.blockEndPos).split('|').map(Number)
    let locate,
        tried = 0,
        lastError
    outer: for (let x = Math.min(start[0], end[0]); x < Math.max(start[0], end[0]); x += 4) {
        for (let y = Math.min(start[1], end[1]); y < Math.max(start[1], end[1]); y += 4) {
            if (++tried > 256) break outer
            const value = { block_id: block.id, anchor: gridAnchor(x, y), direction: 0 }
            try {
                validatePlacement(f.tables, f.state(), fieldType.homeBuildingId, value)
                locate = value
                break outer
            } catch (error) {
                lastError = error
            }
        }
    }
    assert(locate, 'Fixture needs a current legal empty field placement: ' + lastError?.message)
    const open = (request = { field_type: fieldType.id, locate }) => {
        const packets = f.call('FieldOpen', request),
            row = f.protocol.byName.get('CSProtoFieldOpen')
        return { packets, build: f.protocol.decode(row.rsp, packets.find((p) => p.id === row.id).payload) }
    }
    const close = (guid) => f.call('FieldClose', { field_id: guid })
    return { ...f, fieldType, locate, open, close }
}
