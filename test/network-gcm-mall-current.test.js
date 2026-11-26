import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { startServer } from '../src/server.js'
import { LocalErrorCode } from '../src/error-codes.js'
import { parseRewards } from '../src/rewards.js'
import { connectObtGcmClient } from './helpers/obt-gcm-client.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

// Current MallParser/ShopStore contracts already established by
// mall-current-notification and mall-conditions-current. This model consumes
// actual decrypted network frames; it does not render Unity windows or run SDK.
class MallConsumer {
    constructor(tables, protocol) {
        this.tables = tables
        this.protocol = protocol
        this.inventory = new ObtInventoryConsumer(tables, protocol)
        this.vehicles = new Map()
        this.goods = new Map()
        this.requests = []
        this.views = []
        this.orderNotices = []
        this.sdkAttempts = 0
        this.initialized = false
    }
    consume(frames) {
        for (const frame of frames) {
            if (frame.error) continue
            this.inventory.consumePackets([frame])
            const data = this.protocol.decode(this.protocol.byId.get(frame.id).rsp, frame.payload)
            if (frame.id === 6592) for (const row of data.owned_vehicles ?? []) this.vehicles.set(row.guid, row.conf_id)
            if ([18030, 18032].includes(frame.id)) {
                this.initialized = true
                for (const row of [...(data.diamond_goods_list ?? []), ...(data.pay_goods_list ?? [])])
                    this.goods.set(row.goods_id, structuredClone(row))
            }
            if ([18035, 18038].includes(frame.id)) {
                assert.equal(frame.error, 0)
                assert.equal(frame.raw.readUInt16BE(7), 0)
                assert.equal(data.errcode, LocalErrorCode.OfflinePaymentCallback)
                assert.equal(BigInt.asIntN(32, BigInt(data.errcode)), -9999n)
                this.orderNotices.push({ id: frame.id, order: data.order_id })
                if (!(data.errcode ?? 0)) this.sdkAttempts++
            }
            if (frame.id === 18036) {
                const shop = this.tables.get('mall_shop').find((row) => row.shopId === data.pay_shop_id)
                assert(shop)
                // HandleSuccessCurrencyBuy0601ca13 queries this shop, then
                // RefreshPurchaseGoodsAfterBought0601ca18 increments its cache.
                // The success notification is not a full goods snapshot.
                if (shop.goodsList)
                    this.requests.push(['PlayerMallGetDiamondGoodsList', { diamond_shop_id: shop.shopId }])
                if (shop.goodsListPurchase)
                    this.requests.push(['PlayerMallGetPayGoodsList', { pay_shop_id: shop.shopId }])
                const goods = this.goods.get(data.pay_goods_id)
                if (goods) goods.curr_purchase_num = (goods.curr_purchase_num ?? 0) + 1
            }
            if ([18036, 18039].includes(frame.id) && this.initialized) this.requests.push(['GetRechargePopupData', {}])
            if (frame.id !== 18048) continue
            assert.notEqual(data.pay_source, 1, 'These local orders use immediate presentation, not web batching')
            for (const reward of [data.mall_data?.pay_rewards, data.recharge_diamond?.rewards].filter(Boolean)) {
                for (const item of reward.rewards ?? []) {
                    if (item.itemtype === 3) {
                        assert(this.tables.find('common_item', item.itemid))
                        assert(this.inventory.count(item.itemid) >= item.itemnum, 'Bag sync must precede presentation')
                    } else if (item.itemtype === 41) {
                        assert.equal(
                            this.vehicles.get(item.guid),
                            item.itemid,
                            'Vehicle cache must precede presentation',
                        )
                    } else assert.equal(item.itemtype, 10, 'Chosen current fixtures have no unmodeled reward family')
                }
                this.views.push({
                    rewards: structuredClone(reward.rewards),
                    paid: this.inventory.attributes.get(901) ?? 0n,
                    bonus: this.inventory.attributes.get(902) ?? 0n,
                })
            }
            if (data.mall_data || data.recharge_diamond) this.requests.push(['GetRechargePopupData', {}])
        }
    }
    unlocked(id) {
        const row = this.tables.get('mall_pay_goods').find((row) => row.goodsId === id),
            cached = this.goods.get(id)
        assert(row && cached)
        if ((cached.unlock_cond_id ?? []).length && !cached.is_all_cond_done) return false
        return String(row.commonCondition)
            .split('|')
            .filter(Boolean)
            .every((token) => {
                const [kind, mode, target] = token.split('#').map(Number)
                if ((cached.unlock_cond_id ?? []).includes(kind)) return true
                assert.equal(kind, 12280)
                assert.equal(mode, 2)
                const config = this.tables.get('mall_pay_goods').find((row) => row.goodsId === target),
                    wire = this.goods.get(target)
                return config.goodsNum > 0 && !!wire && (wire.curr_purchase_num ?? 0) >= config.goodsNum
            })
    }
}

async function fixture(t, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-gcm-mall-')),
        clients = [],
        warnings = [],
        requests = new Map()
    let server
    try {
        server = await startServer(
            {
                ...configuration(),
                host: '127.0.0.1',
                publicHost: '127.0.0.1',
                gamePort: 0,
                httpPort: 0,
                database: path.join(directory, 'network.sqlite'),
                diagnosticsFile: path.join(directory, 'diagnostics.jsonl'),
                crcDelay: 0,
                strongEncryption: true,
                offlinePayments: true,
                stateFlushMs: 60000,
                entryWorldChatNoticeDelayMs: 3600000,
                cdnUrl: '',
                cdnBackupUrls: [],
            },
            { info() {}, warn: (line) => warnings.push(line) },
        )
        server.game.clock = () => 1800000000
        assert.equal(server.tcp.address().address, '127.0.0.1')
        assert.equal(server.web.address().address, '127.0.0.1')
        assert.notEqual(server.tcp.address().port, server.web.address().port)
        const http = await fetch(`http://127.0.0.1:${server.web.address().port}/version/client/getAccountV1`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverTag: 0, account: 'gcm-mall-resource-check' }),
            signal: AbortSignal.timeout(8000),
        })
        assert.equal(http.status, 200)
        assert.equal((await http.json()).code, 0)
        const connect = async (account, reconnect = false) => {
            const client = await connectObtGcmClient(server)
            clients.push(client)
            const sent = []
            requests.set(client, sent)
            const model = new MallConsumer(server.game.tables, server.protocol)
            let cursor = 0
            const consume = () => {
                const frames = client.trace.slice(cursor)
                cursor = client.trace.length
                model.consume(frames)
                return frames
            }
            const logged = await client.login(account, { reconnect })
            assert.equal(logged.entered.frame.error, 0)
            const initialBarrier = await client.barrier()
            sent.push(initialBarrier.request)
            consume()
            const step = async (name, body = {}) => {
                const response = await client.call(name, body, { fragment: true })
                const ping = await client.barrier()
                sent.push(response.request, ping.request)
                return { ...response, frames: consume() }
            }
            const drain = async () => {
                let count = 0
                while (model.requests.length) {
                    assert(count++ < 24, 'Current ShopStore request chain must terminate')
                    const [name, body] = model.requests.shift()
                    assert.equal((await step(name, body)).frame.error, 0)
                }
                return count
            }
            return { client, model, step, drain, id: logged.playerId }
        }
        await run({ server, connect, warnings })
        assert.equal(
            warnings.some((line) => line.startsWith('Framing:')),
            false,
        )
        const counters = []
        for (const client of clients) {
            const frames = client.trace.filter((frame) => frame.flag & 4)
            assert(frames.some((frame) => frame.flag === 4))
            assert(
                frames.some((frame) => frame.flag === 5),
                'Current large login sync also exercises LZ4+GCM',
            )
            for (const [index, frame] of frames.entries()) {
                assert([4, 5].includes(frame.flag))
                assert.equal(frame.error, 0, 'Chosen positive flow must keep UInt16 transport error clear')
                assert.equal(frame.raw.readUInt16BE(7), 0)
                assert.equal(frame.raw.readBigUInt64BE(25), BigInt(index), 'Connection-local GCM counter is continuous')
            }
            const sent = requests.get(client)
            for (const [index, request] of sent.entries()) {
                assert([4, 5].includes(request.raw[4]))
                assert.equal(
                    request.raw.readBigUInt64BE(25),
                    BigInt(index),
                    'Client GCM counter is independently continuous',
                )
            }
            counters.push({
                requests: sent.length,
                responses: frames.length,
                compressedResponses: frames.filter((frame) => frame.flag === 5).length,
            })
        }
        t.diagnostic(JSON.stringify({ loopback: true, temporarySQLite: true, counters }))
    } finally {
        for (const client of clients) await client.close()
        if (server) await server.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-gcm-mall-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['network.sqlite', 'network.sqlite-journal', 'diagnostics.jsonl'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
}

const cashOrder = (id, nonce, tables) => ({
    pay_shop_id: tables
        .get('mall_shop')
        .find((row) => String(row.goodsListPurchase).split('|').map(Number).includes(id)).shopId,
    pay_goods_id: id,
    buy_count: 1,
    product_id: `lurukaps-offline:${nonce}:gcm-mall`,
    amount: '0',
})
const indexOf = (frames, id) => {
    const index = frames.findIndex((frame) => frame.id === id)
    assert(index >= 0, `Expected network protocol${id}`)
    return index
}

test(
    'current GCM6480 and cash vehicle gift present after wallet/assets with body-only SDK suppression; nonce and new TCP replay never regrant',
    { timeout: 60000 },
    async (t) => {
        await fixture(t, async ({ server, connect }) => {
            const account = 'gcm-mall-recharge-gift',
                a = await connect(account),
                tables = server.game.tables,
                row = tables.get('mall_recharge_diamond').find((row) => row.rechargeDiamondNum === 6480),
                request = {
                    purchase_sdk_id: row.purchaseSdkID,
                    buy_count: 1,
                    product_id: 'lurukaps-offline:gcm-mall-6480:gcm-mall',
                    amount: '0',
                },
                paid = a.model.inventory.attributes.get(901) ?? 0n,
                bonus = a.model.inventory.attributes.get(902) ?? 0n,
                recharge = await a.step('NonMallCreatePayOrder', request)
            assert.equal(recharge.frame.error, 0)
            assert(indexOf(recharge.frames, 5008) < indexOf(recharge.frames, 18048))
            assert(indexOf(recharge.frames, 18043) < indexOf(recharge.frames, 18048))
            assert(indexOf(recharge.frames, 18038) < indexOf(recharge.frames, 18048))
            assert.equal(a.model.views.length, 1)
            assert.equal(a.model.views[0].paid, paid + BigInt(row.rechargeDiamondNum))
            assert.equal(a.model.views[0].bonus, bonus + BigInt(row.firstRechargeBonus))
            assert.equal(await a.drain(), 1, 'Cold ShopStore needs only the unsolicited popup receipt follow-up')
            await a.step('PlayerMallGetPayGoodsList', { pay_shop_id: 305 })
            const gift = cashOrder(30501, 'gcm-mall-vehicle', tables),
                delivered = await a.step('PlayerMallCreatePayOrder', gift)
            assert.equal(delivered.frame.error, 0)
            assert(indexOf(delivered.frames, 6592) < indexOf(delivered.frames, 18048))
            assert(indexOf(delivered.frames, 10006) < indexOf(delivered.frames, 18048))
            assert(indexOf(delivered.frames, 18035) < indexOf(delivered.frames, 18048))
            assert.equal(a.model.views.length, 2)
            assert.equal(a.model.views[1].rewards[0].itemtype, 41)
            assert.equal(a.model.vehicles.get(a.model.views[1].rewards[0].guid), 500927)
            assert((await a.drain()) >= 2)
            const state = () => server.store.load(a.id).state,
                snapshot = () =>
                    structuredClone({
                        mall: state().mall,
                        attrs: state().player.attr_infos,
                        vehicles: state().vehicles,
                    }),
                completed = snapshot()
            for (const [name, body] of [
                ['NonMallCreatePayOrder', request],
                ['PlayerMallCreatePayOrder', gift],
            ]) {
                assert.equal((await a.step(name, body)).frame.error, 0)
                await a.drain()
                assert.deepEqual(snapshot(), completed)
            }
            assert.equal(a.model.views.length, 2)
            assert.equal(a.model.sdkAttempts, 0)
            assert.deepEqual(new Set(a.model.orderNotices.map((row) => row.id)), new Set([18035, 18038]))
            await a.client.close()
            const b = await connect(account, true)
            assert.equal(b.id, a.id)
            assert.notDeepEqual(b.client.serverPublicKey, a.client.serverPublicKey)
            assert.equal(b.model.views.length, 0)
            for (const [name, body] of [
                ['NonMallCreatePayOrder', request],
                ['PlayerMallCreatePayOrder', gift],
            ]) {
                assert.equal((await b.step(name, body)).frame.error, 0)
                await b.drain()
                assert.deepEqual(snapshot(), completed)
            }
            assert.equal(b.model.views.length, 0)
            assert.equal(b.model.sdkAttempts, 0)
            assert.equal(state().mall.popupQueue.length, 0)
        })
    },
)

test(
    'current GCM cash ladder follows18036 shop requery and finite-stock thresholds rather than treating success as a goods snapshot',
    { timeout: 60000 },
    async (t) => {
        await fixture(t, async ({ server, connect }) => {
            const account = 'gcm-mall-cash-ladder',
                a = await connect(account),
                tables = server.game.tables
            await a.step('PlayerMallGetPayGoodsList', { pay_shop_id: 203 })
            assert.equal(a.model.unlocked(20319), false)
            const items = [20309, 20319]
                    .flatMap((id) => parseRewards(tables.get('mall_pay_goods').find((row) => row.goodsId === id).item))
                    .filter((item) => item.itemtype === 3),
                before = new Map(items.map((item) => [item.itemid, a.model.inventory.count(item.itemid)]))
            const requests = [
                cashOrder(20309, 'gcm-mall-tier-one', tables),
                cashOrder(20319, 'gcm-mall-tier-two-a', tables),
                cashOrder(20319, 'gcm-mall-tier-two-b', tables),
            ]
            for (const [index, request] of requests.entries()) {
                const response = await a.step('PlayerMallCreatePayOrder', request)
                assert.equal(response.frame.error, 0)
                assert(indexOf(response.frames, 5008) < indexOf(response.frames, 18048))
                assert(indexOf(response.frames, 18036) < indexOf(response.frames, 18048))
                assert((await a.drain()) >= 2)
                if (index === 0) assert.equal(a.model.unlocked(20319), true)
                assert.equal(a.model.unlocked(20329), index === 2)
            }
            const expected = new Map(before)
            for (const id of [20309, 20319, 20319])
                for (const item of parseRewards(
                    tables.get('mall_pay_goods').find((row) => row.goodsId === id).item,
                ).filter((item) => item.itemtype === 3))
                    expected.set(item.itemid, (expected.get(item.itemid) ?? 0) + item.itemnum)
            for (const [id, count] of expected) assert.equal(a.model.inventory.count(id), count)
            assert.equal(a.model.views.length, 3)
            assert.equal(a.model.sdkAttempts, 0)
            const previous = structuredClone(server.store.load(a.id).state.mall)
            await a.step('PlayerMallCreatePayOrder', requests[2])
            await a.drain()
            assert.equal(
                a.model.goods.get(20319).curr_purchase_num,
                2,
                'Authoritative requery corrects retry cache increment',
            )
            assert.deepEqual(server.store.load(a.id).state.mall, previous)
            assert.equal(a.model.views.length, 3)
            await a.client.close()
            const b = await connect(account, true)
            await b.step('PlayerMallGetPayGoodsList', { pay_shop_id: 203 })
            assert.equal(b.model.unlocked(20329), true)
            assert.equal(b.model.goods.get(20319).curr_purchase_num, 2)
            for (const [id, count] of expected) assert.equal(b.model.inventory.count(id), count)
            assert.equal(b.model.views.length, 0)
        })
    },
)
