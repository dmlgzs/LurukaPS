import { materialClearFixture } from './material-clear-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'

export function mainEntrustFixture(name, filename = ':memory:') {
    const base = materialClearFixture(name, filename)
    const catalog = getEntrustCatalog(base.tables)
    const begin = (id) => {
        const active = base.run()
        if (active && active.entrust_id === id && active.kind === undefined && active.battle_complete)
            base.call('ReEnterEntrust', { entrust_id: id })
        else {
            if (active) {
                base.call('CampaignQuit')
                base.call('WorldMapPlayerRevive')
            }
            base.call('EnterEntrust', { entrust_id: id })
        }
        base.call('MultiCampaignPlayerLoadFinish')
    }
    const advance = ({ pet = false } = {}) => {
        const run = base.run()
        const stage = catalog.stages(run.entrust_id).find((row) => row.index === run.stage_index)
        if (stage?.type === 13) return base.interact(stage.row.id)
        if (stage?.type === 50) {
            base.time(base.now() + 1)
            return base.kill(stage.row.id, { pet })
        }
        throw Error('No active main commission test stage')
    }
    const readyLast = (id) => {
        begin(id)
        const last = catalog
            .stages(id)
            .filter((stage) => stage.type === 50)
            .at(-1)
        for (let index = 0; index < 32; index++) {
            if (base.run().stage_index === last.index) return last.row.id
            advance()
        }
        throw Error('Main commission last wave did not start')
    }
    const win = (id, options) => {
        begin(id)
        for (let index = 0; index < 32 && !base.run().battle_complete; index++) advance(options)
        if (!base.run().battle_complete) throw Error('Main commission did not finish')
        return base.run()
    }
    return {
        ...base,
        material: { begin: base.begin, advance: base.advance, win: base.win },
        catalog,
        begin,
        advance,
        readyLast,
        win,
        chest: () => catalog.chest(base.run().entrust_id),
    }
}
