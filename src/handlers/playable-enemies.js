import { ErrorCode } from '../error-codes.js'
import fs from 'node:fs'
import { ensure } from './common.js'
import { WorldObjectCatalog } from '../world-objects.js'
import { syncAIHeroBeforeCreate } from './ai-heroes.js'
export function registerPlayableEnemies(on, tables, store) {
    const file = new URL('../../configs/playable-enemies.json', import.meta.url),
        source = JSON.parse(fs.readFileSync(file)),
        assets = new Map(source.playables.map((p) => [p.id, p])),
        world = new WorldObjectCatalog(tables)
    ensure(
        source.version === '3217420' && source.clientVersion === '1.0.0',
        'Playable enemy source is not current 1.0.0/3217420',
        ErrorCode.GameConfig,
    )
    on('WorldObjEnemyInfo', (c, r) => {
        const asset = assets.get(r.play_id)
        ensure(asset, 'Playable enemy configuration unavailable', ErrorCode.PlayableNoConf)
        if (r.obj_id) {
            const { row, spawner } = world.object(c.state.world.map_id, r.obj_id)
            ensure(spawner.objectType === 101 && row.expandId === r.play_id, 'Playable does not belong to world object')
        }
        const cache = (c.state.playableEnemies ??= {}),
            key = `${c.state.world.map_id}:${r.obj_id ?? 0}:${r.play_id}`
        let entry = cache[key]
        if (!entry || entry.config_fingerprint !== asset.fingerprint) {
            const monsters = [],
                entities = []
            for (const group of asset.groups) {
                if (!group.enemies.length) continue
                const container = store.nextSequence('playable-monster-container')
                for (let slot = 0; slot < group.enemies.length; slot++) {
                    const uuid = ((7n << 56n) | (BigInt(slot) << 32n) | BigInt(container)).toString()
                    monsters.push({ uuid, index: group.index, enemy_group: group.enemy_group })
                    entities.push({ uuid, config_id: group.enemies[slot], container, index: group.index, slot })
                }
            }
            ensure(monsters.length <= 4096, 'Playable enemy count exceeds limit', ErrorCode.GameConfig)
            entry = {
                config_fingerprint: asset.fingerprint,
                source_sha256: asset.source_sha256,
                monsters,
                entities,
                created_at: c.now,
            }
            cache[key] = entry
        }
        for (const entity of entry.entities)
            if (tables.find('enemy_pack', entity.config_id)?.specialCreateType === 1)
                syncAIHeroBeforeCreate(c, entity.uuid)
        return { play_id: r.play_id, monster_info: { monsters: entry.monsters } }
    })
}
