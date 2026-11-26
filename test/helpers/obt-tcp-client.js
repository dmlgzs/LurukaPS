import net from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { FrameReader, encodeFrame, HEADER_SIZE } from '../../src/wire.js'

// Transport fixture, not a Unity client. Incoming token installation happens
// inside FrameReader's per-frame callback, before a coalesced encrypted frame.
export async function connectObtClient(server, consumers = []) {
    const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
        reader = new FrameReader(),
        queue = [],
        trace = [],
        waiters = new Set(),
        protocol = server.protocol,
        tokenId = protocol.byName.get('CSProtoEnterGameToken').id
    let seq = 1,
        pushSeq = 0,
        key,
        failure
    const wake = () => {
        for (const waiter of waiters) waiter()
    }
    socket.on('error', (error) => {
        failure = error
        wake()
    })
    socket.on('close', wake)
    socket.on('data', (chunk) => {
        try {
            reader.feed(chunk, (frame) => {
                pushSeq = frame.pushSeq
                if (frame.id === tokenId && !frame.error) {
                    key = Buffer.from(protocol.decode(protocol.byId.get(tokenId).rsp, frame.payload).rc4_key, 'base64')
                    assert.equal(key.length, 32)
                    reader.setEncryptionKey(key)
                }
                trace.push(frame)
                queue.push(frame)
                if (!frame.error) for (const consumer of consumers) consumer.consumePackets([frame])
            })
        } catch (error) {
            failure = error
            socket.destroy()
        }
        wake()
    })
    await once(socket, 'connect')
    socket.setNoDelay(true)
    const wait = async (id, sequence, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (failure) throw failure
            const index = queue.findIndex(
                (frame) => frame.id === id && (sequence === undefined || frame.seq === sequence),
            )
            if (index >= 0) return queue.splice(index, 1)[0]
            if (socket.destroyed) throw Error(`Connection closed while waiting for ${id}/${sequence}`)
            await new Promise((resolve) => {
                const timer = setTimeout(done, Math.max(1, deadline - Date.now()))
                function done() {
                    clearTimeout(timer)
                    waiters.delete(done)
                    resolve()
                }
                waiters.add(done)
            })
        }
        throw Error(`No response ${id}/${sequence}`)
    }
    const encode = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, `Current request is not registered: ${name}`)
        const sequence = seq++,
            payload = entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
            raw = encodeFrame({ id: entry.id, seq: sequence, pushSeq, flag: key ? 2 : 0 }, payload, {
                encryptionKey: key,
            })
        assert.equal(raw.readUInt32BE(0), HEADER_SIZE + payload.length)
        assert.equal(raw.readUInt16BE(5), entry.id)
        return { id: entry.id, seq: sequence, raw }
    }
    const send = (name, value, { fragment = false } = {}) => {
        const request = encode(name, value)
        if (fragment) {
            ;(async () => {
                let offset = 0
                for (const end of [1, 4, 7, 24, 25, request.raw.length]) {
                    if (end <= offset || end > request.raw.length) continue
                    socket.write(request.raw.subarray(offset, end))
                    offset = end
                    if (end < request.raw.length) await new Promise((resolve) => setTimeout(resolve, 2))
                }
            })().catch((error) => {
                failure = error
                socket.destroy()
                wake()
            })
        } else socket.write(request.raw)
        return request
    }
    const call = async (name, value = {}, options) => {
        const request = send(name, value, options),
            frame = await wait(request.id, request.seq)
        return {
            request,
            frame,
            data: frame.error ? undefined : protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload),
        }
    }
    return {
        socket,
        reader,
        queue,
        trace,
        encode,
        send,
        call,
        wait,
        get key() {
            return key
        },
        async barrier() {
            const reply = await call('Ping', { client_ts: '9007199254740993' })
            assert.equal(reply.frame.error, 0)
            assert.equal(reply.data.client_ts, '9007199254740993')
            assert.equal(reader.buffer.length, 0)
        },
        async login(account, reconnect = false) {
            const logged = await call(
                'Login',
                { open_id: account, app_version: '1.0.0', reconnect },
                { fragment: true },
            )
            assert.equal(logged.frame.error, 0)
            assert(logged.data.server_token)
            const entered = await call('EnterGame', {
                open_id: account,
                app_version: '1.0.0',
                server_token: logged.data.server_token,
                reconnect,
            })
            assert.equal(entered.frame.error, 0)
            assert.equal(entered.data.player_id, logged.data.pid)
            await this.barrier()
            return entered.data.player_id
        },
        async close() {
            if (socket.closed) return
            const closed = once(socket, 'close').catch(() => {})
            socket.destroy()
            await closed
        },
    }
}
