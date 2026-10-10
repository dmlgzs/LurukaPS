import { publicProfile } from './public-profile.js'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
export class Store {
    constructor(filename, { flushIntervalMs = 5000 } = {}) {
        if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 1000 || flushIntervalMs > 60000)
            throw Error('Invalid deferred flush interval')
        if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
        this.db = new Database(filename)
        this.db.pragma('foreign_keys = ON')
        this.db.pragma('busy_timeout = 5000')
        // DELETE journal also works on VMware shared folders; use a local disk for production.
        this.db.pragma('journal_mode = DELETE')
        const version = this.db.pragma('user_version', { simple: true })
        if (version > 3) throw Error(`Database schema ${version} is newer than this server`)
        this.db.transaction(() => {
            this.db
                .exec(`CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY AUTOINCREMENT, open_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS players(account_id INTEGER PRIMARY KEY REFERENCES accounts(id), state TEXT NOT NULL CHECK(json_valid(state)), revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_log(id INTEGER PRIMARY KEY, account_id INTEGER, message_id INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL CHECK(value>=0));
      CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender_id INTEGER NOT NULL REFERENCES accounts(id),chat_type INTEGER NOT NULL,target_id TEXT NOT NULL,scope_map INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX IF NOT EXISTS chat_sender ON chat_messages(chat_type,sender_id,id);
      CREATE INDEX IF NOT EXISTS chat_target ON chat_messages(chat_type,target_id,id);
      PRAGMA user_version = 3;`)
        })()
        this.accountByOpen = this.db.prepare('SELECT * FROM accounts WHERE open_id=?')
        this.playerById = this.db.prepare('SELECT state,revision FROM players WHERE account_id=?')
        this.savePlayer = this.db.prepare(
            'UPDATE players SET state=?,revision=revision+1,updated_at=? WHERE account_id=?',
        )
        this.log = this.db.prepare('INSERT INTO request_log(account_id,message_id,status,created_at) VALUES(?,?,?,?)')
        this.failedRequest = this.db.prepare(
            "SELECT 1 FROM request_log WHERE account_id=? AND message_id=? AND status='error:1024' AND created_at>=? ORDER BY id DESC LIMIT 1",
        )
        this.pending = new Map()
        this.flushTimer = setInterval(() => {
            try {
                this.flushPending()
            } catch (error) {
                console.warn(`Deferred player flush: ${error.message}`)
            }
        }, flushIntervalMs)
        this.flushTimer.unref()
    }
    login(openId, factory) {
        if (typeof openId !== 'string' || !openId.trim() || Buffer.byteLength(openId) > 128)
            throw Error('Invalid open_id')
        return this.db
            .transaction(() => {
                let account = this.accountByOpen.get(openId)
                if (!account) {
                    const id = Number(
                        this.db.prepare('INSERT INTO accounts(open_id,created_at) VALUES(?,?)').run(openId, Date.now())
                            .lastInsertRowid,
                    )
                    account = { id, open_id: openId }
                    this.db
                        .prepare('INSERT INTO players(account_id,state,updated_at) VALUES(?,?,?)')
                        .run(id, JSON.stringify(factory(id, openId)), Date.now())
                }
                return { id: account.id, ...this.load(account.id) }
            })
            .immediate()
    }
    load(id) {
        const pending = this.pending.get(id)
        if (pending) return { state: structuredClone(pending.state), revision: pending.revision }
        const row = this.playerById.get(id)
        if (!row) throw Error('Player not found')
        return { state: JSON.parse(row.state), revision: row.revision }
    }
    // Trusted synchronous queries must not mutate this borrowed state. In-memory
    // movement/combat can be read without cloning or scheduling a database write.
    read(id, fn) {
        const pending = this.pending.get(id),
            row = pending ? null : this.playerById.get(id)
        if (!pending && !row) throw Error('Player not found')
        const result = fn(pending?.state ?? JSON.parse(row.state))
        if (result?.then) throw Error('Asynchronous player query is forbidden')
        return result
    }
    hasFailedRequestAfter(id, messageId, sinceMs) {
        return !!this.failedRequest.get(id, messageId, sinceMs)
    }
    maxWorldChatRoom() {
        return this.db
            .prepare(
                `SELECT max(1,coalesce(max(room),1)) AS count FROM (
    SELECT CAST(json_extract(state,'$.chatWorldRoom') AS INTEGER) AS room FROM players
    UNION ALL SELECT CAST(target_id AS INTEGER) FROM chat_messages WHERE chat_type=2
  ) WHERE room BETWEEN 1 AND 4294967295`,
            )
            .get().count
    }
    transact(id, messageId, fn, { defer = false, fork, persistWhen, logDeferred = false } = {}) {
        if (defer) {
            const pending = this.pending.get(id),
                row = pending ? null : this.playerById.get(id)
            if (!pending && !row) throw Error('Player not found')
            const base = pending?.state ?? JSON.parse(row.state),
                revision = pending?.revision ?? row.revision
            const state = fork ? fork(base) : structuredClone(base),
                result = fn(state)
            if (result?.then) throw Error('Asynchronous player transaction is forbidden')
            const previousLogs = pending?.logs ?? []
            if (persistWhen?.(state, base)) {
                this.db
                    .transaction(() => {
                        this.savePlayer.run(JSON.stringify(state), Date.now(), id)
                        for (const entry of previousLogs) this.log.run(id, entry.messageId, 'ok', entry.createdAt)
                        this.log.run(id, messageId, 'ok', Date.now())
                    })
                    .immediate()
                this.pending.delete(id)
            } else {
                const logs = logDeferred
                    ? [...previousLogs, { messageId, createdAt: Date.now() }].slice(-256)
                    : previousLogs
                this.pending.set(id, { state, revision, ...(logs.length ? { logs } : {}) })
            }
            return result
        }
        const result = this.db
            .transaction(() => {
                const { state } = this.load(id)
                const result = fn(state)
                if (result?.then) throw Error('Asynchronous player transaction is forbidden')
                this.savePlayer.run(JSON.stringify(state), Date.now(), id)
                for (const entry of this.pending.get(id)?.logs ?? [])
                    this.log.run(id, entry.messageId, 'ok', entry.createdAt)
                this.log.run(id, messageId, 'ok', Date.now())
                return result
            })
            .immediate()
        this.pending.delete(id)
        return result
    }
    nextSequence(name, max = 0xffffffff) {
        if (!this.db.inTransaction) throw Error('Sequence allocation requires a transaction')
        this.db.prepare('INSERT OR IGNORE INTO sequences(name,value) VALUES(?,0)').run(name)
        const row = this.db
            .prepare('UPDATE sequences SET value=value+1 WHERE name=? AND value<? RETURNING value')
            .get(name, max)
        if (!row) throw Error('Sequence exhausted')
        return row.value
    }
    publicProfiles(excludeId, limit = 20) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid profile limit')

        return this.db
            .prepare('SELECT state FROM players WHERE account_id<>? ORDER BY updated_at DESC,account_id LIMIT ?')
            .all(excludeId, limit)
            .map((row) => {
                const state = JSON.parse(row.state),
                    basic = state.player.basic_info
                return publicProfile(basic)
            })
    }
    appendChat(sender, type, target, map, payload) {
        if (!this.db.inTransaction) throw Error('Chat insertion requires a transaction')
        const id = Number(
            this.db
                .prepare('INSERT INTO chat_messages(sender_id,chat_type,target_id,scope_map,payload) VALUES(?,?,?,?,?)')
                .run(sender, type, String(target), map, JSON.stringify(payload)).lastInsertRowid,
        )
        if (id > 0xffffffff) throw Error('Chat sequence exhausted')
        return { ...payload, order: id }
    }
    chatHistory(account, peer, limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid history limit')
        return this.db
            .prepare(
                'SELECT id,payload FROM chat_messages WHERE chat_type=0 AND ((sender_id=? AND target_id=?) OR (sender_id=? AND target_id=?)) ORDER BY id DESC LIMIT ?',
            )
            .all(account, String(peer), peer, String(account), limit)
            .reverse()
            .map((row) => ({ ...JSON.parse(row.payload), order: row.id }))
    }
    chatPeers(account) {
        return this.db
            .prepare(
                'SELECT DISTINCT CASE WHEN sender_id=? THEN CAST(target_id AS INTEGER) ELSE sender_id END AS peer FROM chat_messages WHERE chat_type=0 AND (sender_id=? OR target_id=?) ORDER BY peer LIMIT 50',
            )
            .all(account, account, String(account))
            .map((row) => row.peer)
    }
    chatUnread(account, peer, readOrder) {
        return this.db
            .prepare(
                'SELECT count(*) AS n FROM chat_messages WHERE chat_type=0 AND sender_id=? AND target_id=? AND id>?',
            )
            .get(peer, String(account), readOrder).n
    }
    flushPending() {
        if (!this.pending.size) return
        this.db
            .transaction(() => {
                for (const [id, { state, logs }] of this.pending) {
                    this.savePlayer.run(JSON.stringify(state), Date.now(), id)
                    for (const entry of logs ?? []) this.log.run(id, entry.messageId, 'ok', entry.createdAt)
                }
            })
            .immediate()
        this.pending.clear()
    }
    close() {
        clearInterval(this.flushTimer)
        this.flushPending()
        this.db.close()
    }
}
