import { giveCurrentHero } from './hero-growth-current-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { taskNodeFinishedCurrentAttempt } from '../src/task-node-status.js'

const config = configuration(),
    tables = new Tables(config.tables),
    gameInt = (title) => Number(tables.get('game').find((row) => row.title === title).value),
    heroId = 107002,
    curve = tables.get('hero_favorability_exp')
const giftValue = (gift, target) =>
    String(gift.favourHero).split('|').map(Number).includes(target) ? gift.favourValue : gift.normalValue
const favorite = tables
    .get('hero_favorability_gift')
    .filter((row) => tables.find('common_item', row.id)?.type === 110)
    .sort((a, b) => giftValue(b, heroId) - giftValue(a, heroId))[0]
const totalFavor = (actor) =>
    curve
        .filter((row) => row.favorabilityLevel < actor.favorability_lv)
        .reduce((n, row) => n + row.favorabilityExp, 0) + (actor.favorability_exp ?? 0)
const inventory = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)

function fixture(name, quota = false) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    let now = Date.UTC(2026, 10, 26, 4) / 1000,
        seq = 1,
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: name })
    // Only the current actors this case needs, through real resource1 grants.
    const needed = quota
        ? Math.ceil(gameInt('HERO_FAVORABILITY_ALL_GIFT_NUM') / gameInt('HERO_FAVORABILITY_GIFT_NUM')) + 1
        : 2
    const candidates = [
        heroId,
        ...tables
            .get('hero')
            .filter((r) => r.favor === 1 && r.id !== heroId)
            .map((r) => r.id),
    ]
    for (const id of candidates) {
        const roster = store.load(session.id).state.player.heros_info.heros
        if (!roster.some((h) => h.conf_id === id && !h.trail)) giveCurrentHero(call, id)
        const current = store.load(session.id).state.player.heros_info.heros
        if (
            current.some((h) => h.conf_id === heroId && !h.trail) &&
            current.filter((h) => tables.find('hero', h.conf_id)?.favor === 1).length >= needed
        )
            break
    }

    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn),
        actor = (id = heroId) => state().player.heros_info.heros.find((row) => row.conf_id === id && !row.trail)
    // Independent, explicitly qualified story baseline: system51 requires
    // 12045#106010#179. This suite does not claim to replay that story. It never
    // seeds personal favor, pending favor rewards or successful gift facts.
    const unlock = tables.find('system_unlock', 51).unlockCondi.split('#').map(Number)
    assert.deepEqual(unlock, [12045, 106010, 179])
    edit((s) => {
        s.tasks = s.tasks.filter((row) => row.task_id !== unlock[1])
        s.taskRecords ??= []
        if (!s.taskRecords.some((row) => row.task_id === unlock[1]))
            s.taskRecords.push({ task_id: unlock[1], count: 1 })
    })
    assert(taskNodeFinishedCurrentAttempt(state(), unlock[1], unlock[2]))
    assert.equal(tables.find('hero', heroId).favor, 1)
    assert.equal(actor().favorability_lv, 1)
    assert.equal(actor().favorability_exp ?? 0, 0)
    assert.deepEqual(actor().store_favor_rewards ?? [], [])
    assert.equal(BigInt(actor().guid) >> 56n, 1n)
    assert.equal(BigInt(actor().guid) & 0xffffffffn, BigInt(session.id))
    const gift = (item, count = 1, target = heroId) =>
        call('SendHeroGift', {
            heroId: target,
            item_id: item,
            item_type: tables.find('common_item', item).type,
            num: count,
        })
    const decode = (name, packets) => {
        const entry = protocol.byName.get('CSProto' + name),
            packet = packets.find((row) => row.id === entry.id)
        assert(packet, 'missing ' + name)
        return protocol.decode(entry.rsp, packet.payload)
    }
    return {
        protocol,
        store,
        game,
        call,
        state,
        actor,
        gift,
        decode,
        fund: (id, count) => edit((s) => grantRewards(tables, s, [{ itemtype: 3, itemid: id, itemnum: count }])),
        advance: () => {
            now += 86400
        },
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name })
        },
    }
}

test('current6610 favorite quantity updates the exact owned hero before ACK, earns current6012 rewards and survives reconnect', () => {
    const f = fixture('current-hero-gift-reward')
    try {
        const beforeActor = f.actor(),
            amount = giftValue(favorite, heroId),
            required = curve.find((row) => row.favorabilityLevel === beforeActor.favorability_lv).favorabilityExp,
            count = Math.ceil(required / amount)
        assert(count > 0 && count <= gameInt('HERO_FAVORABILITY_GIFT_NUM'))
        f.fund(favorite.id, count + 2)
        const before = f.state(),
            others = before.player.heros_info.heros.filter((row) => row.guid !== beforeActor.guid),
            packets = f.gift(favorite.id, count),
            reply = f.decode('SendHeroGift', packets)
        assert.deepEqual(reply, { item_id: favorite.id, hero_id: heroId, item_type: 110, num: count })
        assert.equal(inventory(f.state(), favorite.id), inventory(before, favorite.id) - count)
        assert.equal(totalFavor(f.actor()) - totalFavor(beforeActor), amount * count)
        assert.deepEqual(
            f.state().player.heros_info.heros.filter((row) => row.guid !== beforeActor.guid),
            others,
        )
        assert.deepEqual(f.state().player.attr_infos, before.player.attr_infos)
        const playerEntry = f.protocol.byName.get('CSProtoSyncPlayerData'),
            heroPacketIndex = packets.findIndex(
                (row) =>
                    row.id === playerEntry.id &&
                    f.protocol
                        .decode(playerEntry.rsp, row.payload)
                        .heros_info?.heros.some((hero) => hero.guid === beforeActor.guid),
            ),
            sync = heroPacketIndex >= 0 ? f.protocol.decode(playerEntry.rsp, packets[heroPacketIndex].payload) : null,
            wired = sync?.heros_info.heros.find((row) => row.guid === beforeActor.guid)
        assert(wired, 'current hero favor sync is missing')
        assert.equal(wired.favorability_lv, f.actor().favorability_lv)
        assert.equal(wired.favorability_exp, f.actor().favorability_exp)
        assert(heroPacketIndex < packets.findIndex((row) => row.id === 6610))
        const bagRows = packets
            .filter((row) => row.id === playerEntry.id)
            .flatMap((row) => f.protocol.decode(playerEntry.rsp, row.payload).sbag_infos?.items ?? [])
        assert.equal(bagRows.find((row) => row.itemid === favorite.id)?.itemnum, inventory(f.state(), favorite.id))
        const pending = tables
            .get('hero_favorability_info')
            .filter(
                (row) =>
                    row.heroId === heroId &&
                    row.favorabilityLevel > beforeActor.favorability_lv &&
                    row.favorabilityLevel <= f.actor().favorability_lv &&
                    row.reward,
            )
        assert(pending.length > 0)
        assert.deepEqual(
            f.actor().store_favor_rewards,
            pending.map((row) => row.id),
        )
        f.reload()
        assert.deepEqual(
            f.actor().store_favor_rewards,
            pending.map((row) => row.id),
        )
        const beforeClaim = f.state(),
            claimPackets = f.call('GotFavorReward', { u64: beforeActor.guid }),
            claim = f.decode('GotFavorReward', claimPackets),
            expected = pending.flatMap((row) => row.reward.split('|').map((text) => text.split('#').map(Number)))
        assert.deepEqual(
            claim.rewards.map((row) => [row.itemtype, row.itemid, Number(row.itemnum)]),
            expected,
        )
        assert.deepEqual(f.actor().store_favor_rewards, [])
        const gold = expected.filter(([type, id]) => type === 10 && id === 2).reduce((n, row) => n + row[2], 0)
        assert.equal(f.state().player.basic_info.gold, beforeClaim.player.basic_info.gold + gold)
        const claimSyncs = claimPackets
                .filter((row) => row.id === playerEntry.id)
                .map((row) => f.protocol.decode(playerEntry.rsp, row.payload)),
            claimedHero = claimSyncs
                .flatMap((row) => row.heros_info?.heros ?? [])
                .find((row) => row.guid === beforeActor.guid)
        assert(claimedHero, 'claimed reward receipt removal is missing from current hero sync')
        assert.deepEqual(claimedHero.store_favor_rewards, [])
        assert(claimSyncs.some((row) => row.basic_info?.gold === f.state().player.basic_info.gold))
        const afterClaim = f.state()
        assert.deepEqual(f.decode('GotFavorReward', f.call('GotFavorReward', { u64: beforeActor.guid })).rewards, [])
        assert.equal(f.state().player.basic_info.gold, afterClaim.player.basic_info.gold)
        f.reload()
        assert.deepEqual(f.actor().store_favor_rewards, [])
        assert.equal(f.state().player.basic_info.gold, afterClaim.player.basic_info.gold)
    } finally {
        f.store.close()
    }
})

test('current gift quotas count consumed units per hero and across heroes, resetting only at the configured next day', () => {
    const f = fixture('current-hero-gift-day', true)
    try {
        const item = tables.get('hero_favorability_gift')[0],
            perHero = gameInt('HERO_FAVORABILITY_GIFT_NUM'),
            all = gameInt('HERO_FAVORABILITY_ALL_GIFT_NUM'),
            targets = f
                .state()
                .player.heros_info.heros.filter((row) => tables.find('hero', row.conf_id)?.favor === 1)
                .slice(0, Math.ceil(all / perHero) + 1)
        f.fund(item.id, all + perHero + 1)
        f.gift(item.id, perHero, targets[0].conf_id)
        let before = f.state()
        assert.throws(() => f.gift(item.id, 1, targets[0].conf_id), /Daily hero gift limit/)
        assert.deepEqual(f.state(), before)
        let remaining = all - perHero
        for (const target of targets.slice(1)) {
            if (!remaining) break
            const count = Math.min(remaining, perHero)
            f.gift(item.id, count, target.conf_id)
            remaining -= count
        }
        assert.equal(remaining, 0)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, all)
        before = f.state()
        assert.throws(() => f.gift(item.id, 1, targets.at(-1).conf_id), /Daily hero gift limit/)
        assert.deepEqual(f.state(), before)
        f.reload()
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, all)
        f.advance()
        f.gift(item.id, 1, targets[0].conf_id)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
        assert.equal(f.actor(targets[0].conf_id).daily_gift_num, 1)
    } finally {
        f.store.close()
    }
})

test('current furniture gifts are owner-specific single units and do not consume the normal-gift quota', () => {
    const f = fixture('current-hero-furniture')
    try {
        const furniture = tables
            .get('home_dorm_furniture')
            .find(
                (row) =>
                    row.heroId === heroId &&
                    tables.find('common_item', row.id)?.type === 111 &&
                    !f.actor().furnitures?.includes(row.id),
            )
        assert(furniture)
        f.fund(furniture.id, 2)
        const before = f.state(),
            old = f.actor()
        f.gift(furniture.id)
        assert.equal(inventory(f.state(), furniture.id), inventory(before, furniture.id) - 1)
        assert.equal(totalFavor(f.actor()) - totalFavor(old), furniture.value)
        assert(f.actor().furnitures.includes(furniture.id))
        assert.equal(f.actor().daily_gift_num ?? 0, old.daily_gift_num ?? 0)
        assert.equal(
            f.state().player.basic_info.hero_gift_info.gift_num,
            before.player.basic_info.hero_gift_info.gift_num,
        )
        const given = f.state(),
            other = f
                .state()
                .player.heros_info.heros.find(
                    (row) => row.conf_id !== heroId && tables.find('hero', row.conf_id)?.favor === 1,
                )
        assert.throws(() => f.gift(furniture.id), /already been given/)
        assert.throws(() => f.gift(furniture.id, 1, other.conf_id), /another hero/)
        assert.deepEqual(f.state(), given)
        f.reload()
        assert(f.actor().furnitures.includes(furniture.id))
    } finally {
        f.store.close()
    }
})

test('current gift and favor-claim codec failures roll back inventory, daily quota, favor, pending rewards and SQL state', () => {
    const f = fixture('current-hero-gift-codec'),
        original = f.protocol.encode
    try {
        const amount = giftValue(favorite, heroId),
            threshold = curve.find((row) => row.favorabilityLevel === f.actor().favorability_lv).favorabilityExp,
            count = Math.ceil(threshold / amount)
        f.fund(favorite.id, count + 1)
        for (const replyName of ['cs.PlayerData', f.protocol.byName.get('CSProtoSendHeroGift').rsp]) {
            const before = f.state(),
                sql = f.store.db
                    .prepare('SELECT state,revision FROM players WHERE account_id=?')
                    .get(before.player.basic_info.id)
            f.protocol.encode = function (name, ...args) {
                if (name === replyName) throw Error('current-gift-codec')
                return original.call(this, name, ...args)
            }
            assert.throws(() => f.gift(favorite.id, count), /current-gift-codec/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db
                    .prepare('SELECT state,revision FROM players WHERE account_id=?')
                    .get(before.player.basic_info.id),
                sql,
            )
            f.protocol.encode = original
        }
        f.gift(favorite.id, count)
        assert(f.actor().store_favor_rewards.length > 0)
        const beforeClaim = f.state(),
            sql = f.store.db
                .prepare('SELECT state,revision FROM players WHERE account_id=?')
                .get(beforeClaim.player.basic_info.id),
            response = f.protocol.byName.get('CSProtoGotFavorReward').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === response) throw Error('current-favor-claim-codec')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('GotFavorReward', { u64: f.actor().guid }), /current-favor-claim-codec/)
        assert.deepEqual(f.state(), beforeClaim)
        assert.deepEqual(
            f.store.db
                .prepare('SELECT state,revision FROM players WHERE account_id=?')
                .get(beforeClaim.player.basic_info.id),
            sql,
        )
        f.protocol.encode = original
        const badGuid = (
            (BigInt(f.actor().guid) & ~0xffffffffn) |
            BigInt(beforeClaim.player.basic_info.id + 1)
        ).toString()
        assert.throws(
            () => f.call('GotFavorReward', { u64: badGuid }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), beforeClaim)
        assert(f.decode('GotFavorReward', f.call('GotFavorReward', { u64: f.actor().guid })).rewards.length > 0)
        f.reload()
        assert.deepEqual(f.actor().store_favor_rewards, [])
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})
