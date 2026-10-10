import { createPets, createCustomizedPets } from './pets.js'
import { ensureHome, addHomeBuildings, refreshAutoCropShortcut } from './home.js'
import { ensureHomeDormitories, grantDormStyle } from './home-dorm.js'
import { ensure } from './handlers/common.js'
import { addItems } from './inventory.js'
import { createEggs } from './eggs.js'
import { createCustomOrnaments } from './ornaments.js'
import { syncCurrencyMirrors } from './currency.js'
import { heroData } from './player.js'
import { mainHeroConfigId } from './main-hero.js'
import { changeTaskItem } from './task-items.js'
export function parseRewards(value, allowZero = false) {
    if (!value) return []
    return String(value)
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [itemtype, itemid, itemnum, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length &&
                    [itemtype, itemid].every((n) => Number.isSafeInteger(n) && n > 0) &&
                    Number.isSafeInteger(itemnum) &&
                    itemnum >= (allowZero ? 0 : 1) &&
                    itemnum <= 0xffffffff,
                'Malformed reward configuration',
                1007,
            )
            return { itemtype, itemid, itemnum }
        })
}
export function grantRewards(tables, state, rewards, depth = 0) {
    ensure(depth <= 100, 'Reward recursion limit', 1007)
    const granted = []
    for (const reward of rewards) {
        const { itemtype, itemid, itemnum } = reward
        ensure(
            [itemtype, itemid, itemnum].every((x) => Number.isSafeInteger(x) && x > 0) && itemnum <= 0xffffffff,
            'Invalid reward quantity',
        )
        if (itemtype === 1) {
            ensure(
                itemnum === 1 && tables.find('hero', itemid)?.isUsable === 1,
                'Unknown or nonunique reward hero',
                1007,
            )
            const heroes = state.player.heros_info.heros
            let hero = heroes.find((h) => h.conf_id === itemid)
            if (!hero) {
                const mainId = mainHeroConfigId(tables, state.player.basic_info.sex)
                hero = heroData(itemid, state.player.basic_info.id, itemid === mainId ? 1 : 0)
                ensure(!heroes.some((h) => h.guid === hero.guid), 'Reward hero identity collision', 1007)
                heroes.push(hero)
            }
            if (state.home) ensureHomeDormitories(tables, state)
            granted.push({ ...reward, guid: hero.guid })
            continue
        }
        if (itemtype === 3) {
            ensure(tables.find('common_item', itemid), 'Unknown reward item', 1007)
            addItems(state, [reward])
            if (state.home) refreshAutoCropShortcut(tables, state, itemid)
        } else if (itemtype === 20) {
            changeTaskItem(tables, state, itemid, itemnum)
        } else if (itemtype === 5) {
            const pets = createPets(tables, state, itemid, itemnum)
            granted.push(...pets.map((p) => ({ itemtype: 5, itemid, itemnum: 1, guid: p.guid })))
            continue
        } else if (itemtype === 30) {
            const pets = createCustomizedPets(tables, state, itemid, itemnum)
            granted.push(...pets.map((p) => ({ itemtype: 30, itemid, itemnum: 1, guid: p.guid })))
            continue
        } else if (itemtype === 9) {
            ensure(tables.find('soulessence', itemid), 'Unknown equipment', 1007)
            const bag = state.player.soulessence_infos.soulessences
            ensure(itemnum <= 1000 && bag.length + itemnum <= 10000, 'Equipment bag limit')
            let next = Math.max(state.nextEssenceGuid ?? 1, ...bag.map((e) => e.guid + 1))
            ensure(next + itemnum - 1 <= 0xffffffff, 'Equipment identity space exhausted')
            for (let i = 0; i < itemnum; i++) {
                const guid = next++
                bag.push({ guid, id: itemid, lv: 1, rank: 1, advance: 1, exp: 0, lock: true, wear_hero: '0' })
                granted.push({ itemtype, itemid, itemnum: 1, guid: String(guid) })
            }
            state.nextEssenceGuid = next
            continue
        } else if (itemtype === 25) {
            ensure(tables.find('mount_saddle', itemid), 'Unknown mount saddle', 1007)
            state.mountSaddles ??= tables.get('mount_saddle').map((r) => r.id)
            if (!state.mountSaddles.includes(itemid)) state.mountSaddles.push(itemid)
        } else if (itemtype === 40) {
            ensureHome(tables, state)
            grantDormStyle(tables, state, itemid)
        } else if (itemtype === 28) {
            ensure(tables.find('library_readings', itemid), 'Unknown reading', 1007)
            const books = (state.readingBooks ??= {})
            if (books[itemid]) continue
            books[itemid] = { book_id: itemid, book_state: 0 }
            granted.push({ itemtype, itemid, itemnum: 1 })
            continue
        } else if (itemtype === 13) {
            addHomeBuildings(tables, state, itemid, itemnum)
        } else if (itemtype === 14) {
            const eggs = createEggs(tables, state, itemid, itemnum)
            granted.push(...eggs.map((e) => ({ itemtype: 14, itemid, itemnum: 1, guid: String(e.guid) })))
            continue
        } else if (itemtype === 33) {
            const ornaments = createCustomOrnaments(tables, state, itemid, itemnum)
            // Type 33 is the generation recipe. The acquired item is an accessory
            // instance (type 15); CBT3 only initializes its card details in that branch.
            granted.push(
                ...ornaments.map((entry) => ({ itemtype: 15, itemid: entry.id, itemnum: 1, guid: String(entry.guid) })),
            )
            continue
        } else if (itemtype === 10) {
            const basic = state.player.basic_info
            if (itemid === 1 || itemid === 2) {
                const key = itemid === 1 ? 'diamond' : 'gold'
                ensure(basic[key] + itemnum <= 0x7fffffff, 'Currency overflow')
                basic[key] += itemnum
                syncCurrencyMirrors(state.player)
            } else if (itemid === 10) {
                ensure(
                    Number.isSafeInteger(basic.exp + itemnum) && basic.exp + itemnum <= 0x7fffffff,
                    'Experience overflow',
                )
                basic.exp += itemnum
                const rows = tables.get('player_level'),
                    max = Math.max(...rows.map((x) => x.id))
                while (basic.lv < max) {
                    const row = tables.find('player_level', basic.lv)
                    ensure(row && Number.isSafeInteger(row.exp) && row.exp > 0, 'Invalid player level curve', 1007)
                    if (basic.exp < row.exp) break
                    basic.exp -= row.exp
                    basic.lv++
                    const next = tables.find('player_level', basic.lv)
                    granted.push(...grantRewards(tables, state, parseRewards(next.reward), depth + 1))
                }
            } else {
                const attrs = state.player.attr_infos.attrs
                let a = attrs.find((x) => x.attr_id === itemid)
                if (!a) {
                    a = { attr_id: itemid, attr_val: '0' }
                    attrs.push(a)
                }
                const n = BigInt(a.attr_val) + BigInt(itemnum)
                ensure(n <= 0xffffffffffffffffn, 'Currency overflow')
                a.attr_val = String(n)
            }
        } else ensure(false, `Unsupported reward type ${itemtype}`, 1021)
        granted.push(reward)
    }
    return granted
}
