import net from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'
import { FrameReader, encodeFrame } from '../../src/wire.js'
import { deriveGateMaterial } from '../../src/wire-ecdh.js'
import { GateGcmCipher } from '../../src/wire-gcm.js'
import { requestCrc } from '../../src/wire-crc.js'

// Protocol simulation, not a Unity client. Private/session keys remain in memory only.
export async function connectObtGcmClient(server) {
    const socket = net.connect(server.tcp.address().port, '127.0.0.1')
    const reader = new FrameReader()
    const { privateKey, publicKey } = generateKeyPairSync('x25519')
    const clientPublicKey = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
    const protocol = server.protocol
    const trace = [],
        queue = [],
        rawQueue = [],
        waiters = new Set(),
        crcQueue = []
    let sequence = 1,
        pushSeq = 0,
        crcDelay = 0,
        cipher,
        serverPublicKey,
        failure,
        rawBuffer = Buffer.alloc(0)
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
            rawBuffer = Buffer.concat([rawBuffer, chunk])
            while (rawBuffer.length >= 4 && rawBuffer.length >= rawBuffer.readUInt32BE()) {
                const size = rawBuffer.readUInt32BE()
                assert(size >= 25)
                rawQueue.push(Buffer.from(rawBuffer.subarray(0, size)))
                rawBuffer = rawBuffer.subarray(size)
            }
            reader.feed(chunk, (frame) => {
                frame.raw = rawQueue.shift()
                assert(frame.raw)
                pushSeq = frame.pushSeq
                if (frame.id === 5011) {
                    // MainChannel.GameEnterCallbackHandle06031757: only assign delay, never clear the queue.
                    crcDelay = frame.error
                        ? 0
                        : (protocol.decode(protocol.byId.get(5011).rsp, frame.payload).crc_rand_index ?? 0)
                }
                if (frame.id === 5014 && !frame.error) {
                    const token = protocol.decode(protocol.byId.get(5014).rsp, frame.payload)
                    assert.equal(token.crytype, 1, 'v3 server must select crytype1')
                    assert.equal(token.crypto_version, 3)
                    const peer = Buffer.from(token.server_public_key, 'base64')
                    assert.equal(peer.length, 32)
                    if (serverPublicKey) {
                        assert.deepEqual(peer, serverPublicKey, 'connection public key cannot change')
                    } else {
                        serverPublicKey = peer
                        const key = createPublicKey({
                            key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), peer]),
                            type: 'spki',
                            format: 'der',
                        })
                        const secret = diffieHellman({ privateKey, publicKey: key })
                        let material
                        try {
                            material = deriveGateMaterial(secret, clientPublicKey, peer)
                            cipher = new GateGcmCipher(material, { role: 'client' })
                            reader.setGcmCipher(cipher)
                        } finally {
                            secret.fill(0)
                            material?.fill(0)
                        }
                    }
                }
                trace.push(frame)
                queue.push(frame)
            })
        } catch (error) {
            failure = error
            socket.destroy()
        }
        wake()
    })
    await once(socket, 'connect')
    socket.setNoDelay(true)
    const until = async (predicate, timeout = 8000) => {
        const deadline = Date.now() + timeout
        while (!predicate()) {
            if (failure) throw failure
            if (socket.destroyed) throw Error('GCM test connection closed')
            if (Date.now() >= deadline) throw Error('GCM test response timeout')
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
    }
    const wait = async (id, seq) => {
        let index
        await until(
            () =>
                (index = queue.findIndex((frame) => frame.id === id && (seq === undefined || frame.seq === seq))) >= 0,
        )
        return queue.splice(index, 1)[0]
    }
    const encode = (name, value = {}, { weak = false, retryOf, compressedPayload, crcOverride } = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry)
        const seq = retryOf?.seq ?? sequence++
        const payload = retryOf?.payload ?? (entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0))
        const frame = {
            id: entry.id,
            seq,
            pushSeq: retryOf?.pushSeq ?? pushSeq,
            signature: retryOf?.signature ?? 0n,
            error: crcOverride ?? crcQueue[0] ?? retryOf?.newCrc ?? 0,
            payload,
        }
        const packedPayload = compressedPayload ?? payload
        if (compressedPayload)
            assert(payload.length >= 1024 && packedPayload.length > 0 && packedPayload.length < payload.length)
        const raw = encodeFrame({ ...frame, flag: compressedPayload ? 1 : 0 }, packedPayload, {
            gcmCipher: weak ? undefined : cipher,
        })
        return { ...frame, raw, newCrc: requestCrc(frame), packedPayload, crcQueueBefore: [...crcQueue] }
    }
    const transmit = async (request, { fragment = false } = {}) => {
        const write = (bytes) =>
            new Promise((resolve, reject) => socket.write(bytes, (error) => (error ? reject(error) : resolve())))
        if (fragment) {
            for (const [start, end] of [
                [0, 1],
                [1, 7],
                [7, 25],
                [25, request.raw.length],
            ]) {
                if (end > start) await write(request.raw.subarray(start, end))
                if (end < request.raw.length) await new Promise((resolve) => setTimeout(resolve, 2))
            }
        } else await write(request.raw)
        // TcpSocket.ToSend06004cfb IL00b4+: enqueue only after the complete frame write; shift once.
        crcQueue.push(request.newCrc)
        if (crcQueue.length > crcDelay) crcQueue.shift()
    }
    const call = async (name, value = {}, options) => {
        const request = encode(name, value, options)
        await transmit(request, options)
        const frame = await wait(request.id, request.seq)
        return {
            request,
            frame,
            data: frame.error ? undefined : protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload),
        }
    }
    return {
        socket,
        reader,
        trace,
        queue,
        encode,
        transmit,
        call,
        wait,
        until,
        clientPublicKey,
        get crc() {
            return { delay: crcDelay, queue: [...crcQueue] }
        },
        get cipher() {
            return cipher
        },
        get serverPublicKey() {
            return serverPublicKey && Buffer.from(serverPublicKey)
        },
        async login(account, { reconnect = false, enterOverrides = {} } = {}) {
            const login = await call('Login', { open_id: account, app_version: '1.0.0', reconnect }, { fragment: true })
            assert.equal(login.frame.error, 0)
            const enterValue = {
                open_id: account,
                app_version: '1.0.0',
                server_token: login.data.server_token,
                reconnect,
                crypto_version: 3,
                client_public_key: clientPublicKey.toString('base64'),
                ...enterOverrides,
            }
            const entered = await call('EnterGame', enterValue, { fragment: true })
            return { login, entered, enterValue, playerId: login.data.pid }
        },
        async barrier({ weak = false } = {}) {
            const response = await call('Ping', { client_ts: '9007199254740993' }, { weak })
            assert.equal(response.frame.error, 0)
            assert.equal(response.data.client_ts, '9007199254740993')
            return response
        },
        async closed(timeout = 8000) {
            if (socket.destroyed) return
            await Promise.race([
                once(socket, 'close'),
                new Promise((_, reject) => {
                    const timer = setTimeout(
                        () => reject(Error('Server did not close invalid GCM connection')),
                        timeout,
                    )
                    timer.unref()
                }),
            ])
        },
        async close() {
            if (!socket.closed) {
                const closed = once(socket, 'close').catch(() => {})
                socket.destroy()
                await closed
            }
            cipher?.dispose()
        },
    }
}
