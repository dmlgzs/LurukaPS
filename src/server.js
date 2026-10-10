import { announcementHttpData, announcementBody } from './announcements.js'
import { ProtocolDiagnostics } from './diagnostics.js'
import { sourceRevision } from './build-info.js'
import { DelayedCrc } from './wire-crc.js'
import { randomBytes } from 'node:crypto'
import { ReplayWindow } from './replay.js'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { Protocol } from './protocol.js'
import { Store } from './store.js'
import { Tables } from './player.js'
import { Game } from './game.js'
import { FrameReader, encodeFrame } from './wire.js'

const ENTRY_WORLD_CHAT_DELAY_MS = 15_000
const ENTRY_WORLD_CHAT_TEXT_BASE64 =
    'THVydWthUFMg5piv5YWN6LS555qE77yM5LuF5L6b5a2m5Lmg56CU56m25Y2P6K6u5a6e546w77yM5Lil56aB55So5LqO5ZWG5Lia55So6YCU44CCTHVydWthUFMgaXMgZnJlZSBhbmQgaW50ZW5kZWQgZm9yIGxlYXJuaW5nIGFuZCBwcm90b2NvbCByZXNlYXJjaCBvbmx5OyBjb21tZXJjaWFsIHVzZSBpcyBwcm9oaWJpdGVkLg=='
const LURUKAPS_CHAT_PROFILE_HEAD_ID = 10114 // CBT3 playercard_dress entry for Luluka
const LURUKAPS_CHAT_PROFILE_FRAME_ID = 10231 // CBT3 playercard_dress: Kibo Duel Legend frame

async function readJsonBody(req, maxBytes = 1024 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > maxBytes) throw Error('HTTP body too large')
        chunks.push(chunk)
    }
    if (!size) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}
function requestInt(value, fallback) {
    const n = Number(value)
    return Number.isInteger(n) ? n : fallback
}
function requestString(value, fallback) {
    return typeof value === 'string' && value.length ? value : fallback
}

export async function startServer(config, logger = console) {
    const runtime = {
        revision: sourceRevision(config.base),
        startedAt: new Date().toISOString(),
        offlinePayments: config.offlinePayments ?? true,
    }
    new DelayedCrc(config.crcDelay ?? 0) // Validate before opening the database/listeners.
    const protocol = new Protocol(config.base),
        store = new Store(config.database, { flushIntervalMs: config.stateFlushMs ?? 5000 }),
        tables = new Tables(config.tables),
        game = new Game(protocol, store, tables, {
            crcDelay: config.crcDelay ?? 0,
            gmEnabled: config.gmEnabled ?? true,
            offlinePayments: config.offlinePayments ?? true,
            taskEventDiagnosticsFile: config.diagnosticsFile,
        })
    const diagnostics = new ProtocolDiagnostics(
        config.database === ':memory:' && !config.diagnosticsForTests ? null : config.diagnosticsFile,
        logger,
    )
    const sockets = new Set(),
        owners = new Map(),
        sessions = new Map()
    function deliverTo(id, packet) {
        const target = owners.get(id),
            connection = target && sessions.get(target)
        if (!connection?.session.entered || target.destroyed) return false
        try {
            if (target.writableLength > 8 * 1024 * 1024) {
                target.destroy()
                return false
            }
            connection.replay.invalidate()
            const destination = connection.session
            destination.ntfSeq = ((destination.ntfSeq ?? 0) + 1) >>> 0
            target.write(
                encodeFrame(
                    { ...packet, seq: 0, pushSeq: destination.ntfSeq, flag: destination.wireKey ? 2 : 0 },
                    packet.payload,
                    { encryptionKey: destination.wireKey },
                ),
            )
            return true
        } catch (err) {
            logger.warn(`Push delivery: ${err.message}`)
            target.destroy()
            return false
        }
    }
    function scheduleEntryWorldChatNotice(session, socket) {
        if (session.entryChatNoticeTimer) clearTimeout(session.entryChatNoticeTimer)
        const delayMs =
            Number.isInteger(config.entryWorldChatNoticeDelayMs) && config.entryWorldChatNoticeDelayMs >= 0
                ? config.entryWorldChatNoticeDelayMs
                : ENTRY_WORLD_CHAT_DELAY_MS
        session.entryChatNoticeTimer = setTimeout(() => {
            logger.info(`Entry world chat: sending to ${session.id}`)
            session.entryChatNoticeTimer = undefined
            if (!session.entered || !session.id || owners.get(session.id) !== socket || socket.destroyed) {
                logger.info(`Entry world chat: skipped inactive session ${session.id}`)
                return
            }
            try {
                const state = store.load(session.id).state,
                    now = Math.floor(Date.now() / 1000),
                    room = Number.isInteger(state.chatWorldRoom) && state.chatWorldRoom > 0 ? state.chatWorldRoom : 1,
                    basicInfo = state.player.basic_info,
                    packet = game.packet('CSProtoChatInfoChange', {
                        target: { tid: String(room), chat_type: 2 },
                        chat: {
                            msg: ENTRY_WORLD_CHAT_TEXT_BASE64,
                            time: now,
                            type: 0,
                            player_id: 0,
                            order: now,
                            basic_info: {
                                id: 0,
                                zone_id: basicInfo.zone_id ?? 1,
                                name: 'RGltb2xl',
                                sex: 2,
                                birth: 0,
                                lv: 80,
                                stand_plates: {
                                    profile: LURUKAPS_CHAT_PROFILE_HEAD_ID,
                                    profile_frame: LURUKAPS_CHAT_PROFILE_FRAME_ID,
                                },
                            },
                            extra_info: '',
                            bubbleId: 0,
                            language: basicInfo.language ?? 1,
                        },
                    })
                if (deliverTo(session.id, packet)) logger.info(`Entry world chat: delivered 9932 to ${session.id}`)
                else logger.warn(`Entry world chat: delivery rejected for ${session.id}`)
            } catch (err) {
                logger.warn(`Entry world chat: ${err.message}`)
            }
        }, delayMs)
        session.entryChatNoticeTimer.unref()
    }
    const tcp = net.createServer((socket) => {
        if (sockets.size >= config.maxConnections) {
            socket.destroy()
            return
        }
        sockets.add(socket)
        socket.setNoDelay(true)
        socket.setTimeout(config.idleTimeout, () => socket.destroy())
        const reader = new FrameReader(),
            session = {},
            replay = new ReplayWindow(),
            crc = new DelayedCrc()
        sessions.set(socket, { session, replay })
        socket.on('error', (err) => logger.warn(`Socket: ${err.code || err.message}`))
        socket.on('close', () => {
            sockets.delete(socket)
            sessions.delete(socket)
            if (session.entryChatNoticeTimer) clearTimeout(session.entryChatNoticeTimer)
            if (owners.get(session.id) === socket) owners.delete(session.id)
        })
        socket.on('data', (chunk) => {
            let activeFrame
            session.recentFrames ??= []
            try {
                for (const frame of reader.feed(chunk)) {
                    activeFrame = frame
                    session.recentFrames.push({
                        message_id: frame.id,
                        sequence: frame.seq,
                        push_sequence: frame.pushSeq,
                    })
                    if (session.recentFrames.length > 16) session.recentFrames.shift()
                    if (socket.writableLength > 8 * 1024 * 1024) throw Error('Outbound queue limit')
                    crc.accept(frame)
                    const cached = replay.find(frame)
                    if (cached) {
                        for (const buffer of cached) socket.write(buffer)
                        activeFrame = undefined
                        continue
                    }
                    let packets
                    try {
                        const entering = !session.entered
                        packets = game.dispatch(session, frame)
                        if (entering && session.entered) crc.setDelay(config.crcDelay ?? 0)
                        if (entering && session.entered && config.strongEncryption) {
                            const nextKey = randomBytes(32)
                            packets.unshift({
                                ...game.packet('CSProtoEnterGameToken', { rc4_key: nextKey.toString('base64') }),
                                installKey: nextKey,
                            })
                        }
                        if (session.id) {
                            const old = owners.get(session.id)
                            if (old && old !== socket) old.destroy()
                            owners.set(session.id, socket)
                        }
                        if (entering && session.entered) scheduleEntryWorldChatNotice(session, socket)
                    } catch (err) {
                        diagnostics.record({ protocol, frame, accountId: session.id, error: err })
                        try {
                            store.log.run(
                                session.id ?? null,
                                frame.id,
                                `error:${Number.isInteger(err.code) ? err.code : 1002}`,
                                Date.now(),
                            )
                        } catch (logError) {
                            logger.warn(`Request error audit: ${logError.message}`)
                        }
                        logger.warn(`${protocol.byId.get(frame.id)?.name || frame.id}: ${err.message}`)
                        packets = [
                            {
                                id: frame.id,
                                seq: frame.seq,
                                pushSeq: frame.pushSeq,
                                error: err.code && Number.isInteger(err.code) ? err.code : 1002,
                            },
                        ]
                    }
                    const encoded = []
                    for (const packet of packets) {
                        if (packet.recipient && packet.recipient !== session.id) {
                            deliverTo(packet.recipient, packet)
                            continue
                        }
                        if (packet.audience) {
                            for (const [id, target] of owners) {
                                if (id === session.id || !sessions.get(target)?.session.entered) continue
                                const state = store.load(id).state
                                if ((state.blockedPlayers ?? []).includes(packet.audience.sender)) continue
                                const matches =
                                    packet.audience.kind === 'world'
                                        ? (state.chatWorldRoom ?? 1) === packet.audience.room
                                        : state.world.map_id === packet.audience.map
                                if (matches) deliverTo(id, packet)
                            }
                            continue
                        }
                        // CBT3 MainChannel.OnReceiveMsg assigns pushSeq on every received message.
                        // Unsolicited pushes therefore advance the notification sequence; responses retain it.
                        session.ntfSeq ??= frame.pushSeq
                        if (!packet.seq) session.ntfSeq = (session.ntfSeq + 1) >>> 0
                        encoded.push(
                            encodeFrame(
                                {
                                    ...packet,
                                    pushSeq: session.ntfSeq,
                                    flag: session.wireKey && packet.id !== 5001 && packet.id !== 1001 ? 2 : 0,
                                },
                                packet.payload,
                                { encryptionKey: session.wireKey },
                            ),
                        )
                        if (packet.installKey) {
                            session.wireKey = packet.installKey
                            reader.setEncryptionKey(packet.installKey)
                        }
                    }
                    replay.save(frame, encoded)
                    for (const buffer of encoded) socket.write(buffer)
                    if (session.close) {
                        socket.end()
                        break
                    }
                    activeFrame = undefined
                }
            } catch (err) {
                diagnostics.record({
                    phase: 'framing',
                    protocol,
                    frame: activeFrame,
                    replayHigh: replay.high,
                    connection: {
                        revision: runtime.revision,
                        entry: session.entryAttempt,
                        recent_frames: session.recentFrames,
                    },
                    accountId: session.id,
                    error: err,
                    receivedBytes: chunk.length,
                })
                logger.warn(`Framing: ${err.message}`)
                socket.destroy()
            }
        })
    })
    const web = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const timestamp = Math.floor(Date.now() / 1000)
        let data, api
        if (url.pathname.startsWith('/announcements/')) {
            const match = /^\/announcements\/(\d+)\.html$/.exec(url.pathname)
            const body = match && announcementBody(match[1], timestamp)
            if (!['GET', 'HEAD'].includes(req.method)) {
                res.writeHead(405)
                res.end()
                return
            }
            if (body === undefined || body === null) {
                res.writeHead(404)
                res.end()
                return
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(req.method === 'HEAD' ? undefined : body)
            return
        }
        if (url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
                JSON.stringify({
                    status: 'ok',
                    target: 'CBT3',
                    runtime,
                    databaseSchema: store.db.pragma('user_version', { simple: true }),
                    diagnosticsEnabled: !diagnostics.disabled,
                    protocols: protocol.entries.length,
                    handlers: game.handlers.size,
                    missingSchemas: protocol.missing.length,
                }),
            )
            return
        }
        if (!['GET', 'POST'].includes(req.method)) {
            res.writeHead(405)
            res.end()
            return
        }
        let requestBody = {}
        try {
            requestBody = await readJsonBody(req)
        } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ code: 400, message: err.message }))
            return
        }
        switch (url.pathname) {
            case '/version/client/patchV1': {
                api = 'PatchV1'
                const zoneId = requestInt(requestBody.zoneId, 22),
                    buildPipe = requestInt(requestBody.buildPipe, 1)
                const jobName = requestString(requestBody.jobName, config.jobName),
                    version = requestString(config.version, requestString(requestBody.version, '')),
                    hotVersion = requestString(config.hotRevision, requestString(requestBody.hotVersion, ''))
                const gamePort = Number(tcp.address().port)
                const slot = {
                    serverInfo: [
                        {
                            name: config.serverName,
                            type: 4,
                            addr: config.publicHost,
                            port: gamePort,
                            bakGate: JSON.stringify([{ addr: config.publicHost, port: gamePort }]),
                            state: 0,
                            version: '',
                            tag: config.serverTag,
                            tls: false,
                            desc: config.serverDescription,
                            timestamp,
                            pay: '',
                            id: config.serverId,
                            zoneId,
                            clientLog: config.clientLogUrl,
                        },
                    ],
                }
                data = {
                    status: 4,
                    pkgUrl: config.packageUrl || `http://${config.publicHost}:${web.address().port}/`,
                    zoneId,
                    buildPipe,
                    jobName,
                    version,
                    waterMark: { accessKeyId: '', accessKeySecret: '', url: '' },
                    serverSlots: { releaseServer: slot },
                    hotSlots: { releaseHot: hotVersion },
                    returnAll: 0,
                    isWhite: 0,
                    isForceHot: config.isForceHot ?? false,
                    releaseHotHis: config.releaseHotHistory ?? [],
                }
                break
            }
            case '/version/client/getCdnV1':
                api = 'GetCdnV1'
                data = {
                    cdn: config.cdnUrl || `http://${config.publicHost}:${web.address().port}/`,
                    cdnBak: config.cdnBackupUrls ?? [],
                }
                break
            case '/version/client/cdntoken':
                api = 'CdnToken'
                data = {
                    tc: {
                        tmpSecretID: '',
                        tmpSecretKey: '',
                        sessionToken: '',
                        expiredTime: 0xffffffff,
                        url: '',
                        type: 0,
                        appid: '',
                        region: '',
                        bucket: '',
                    },
                }
                break
            case '/version/client/announceV1':
                api = 'AnnounceV1'
                data = announcementHttpData(game.announcementBaseUrl, timestamp)
                break
            default:
                res.writeHead(404, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ code: 404, message: 'Not found' }))
                return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ api, code: 0, message: 'OK', extra: '', timestamp, data }))
    })
    web.requestTimeout = 10000
    web.headersTimeout = 10000
    try {
        tcp.listen(config.gamePort, config.host)
        await once(tcp, 'listening')
        web.listen(config.httpPort, config.host)
        await once(web, 'listening')
        game.announcementBaseUrl = `http://${config.publicHost}:${web.address().port}/`
    } catch (err) {
        if (tcp.listening) tcp.close()
        if (web.listening) web.close()
        store.close()
        throw err
    }
    const productionTimer = setInterval(() => {
        for (const [socket, { session, replay }] of sessions) {
            if (!session.entered || owners.get(session.id) !== socket) continue
            try {
                const packets = game.tick(session.id, session)
                if (packets.length) replay.invalidate()
                for (const packet of packets) {
                    if (socket.writableLength > 8 * 1024 * 1024) {
                        socket.destroy()
                        break
                    }
                    session.ntfSeq = ((session.ntfSeq || 0) + 1) >>> 0
                    socket.write(
                        encodeFrame(
                            { ...packet, pushSeq: session.ntfSeq, flag: session.wireKey ? 2 : 0 },
                            packet.payload,
                            { encryptionKey: session.wireKey },
                        ),
                    )
                }
            } catch (err) {
                logger.warn(`Production update: ${err.message}`)
            }
        }
    }, 1000)
    productionTimer.unref()
    return {
        tcp,
        web,
        game,
        protocol,
        store,
        runtime,
        async close() {
            clearInterval(productionTimer)
            for (const s of sockets) s.destroy()
            await Promise.all([
                new Promise((resolve) => tcp.close(resolve)),
                new Promise((resolve) => web.close(resolve)),
            ])
            store.close()
        },
    }
}
