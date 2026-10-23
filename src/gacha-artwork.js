import { createHash } from 'node:crypto'
import configured from '../configs/gacha-artwork.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export class GachaArtwork {
    constructor(config = configured) {
        ensure(
            config?.schema_version === 1 &&
                config.mode === 'local-base-outfit-client-gacha-portrait' &&
                Array.isArray(config.images),
            'Invalid gacha artwork configuration',
            ErrorCode.GameConfig,
        )
        this.images = new Map()
        this.files = new Map()
        for (const row of config.images) {
            ensure(
                row &&
                    typeof row.key === 'string' &&
                    /^(1|9):[1-9]\d*$/.test(row.key) &&
                    !this.images.has(row.key) &&
                    Number.isSafeInteger(Number(row.key.split(':')[1])) &&
                    Number(row.key.split(':')[1]) <= 0xffffffff &&
                    typeof row.png === 'string' &&
                    /^[0-9a-f]{64}$/.test(row.sha256),
                'Invalid gacha artwork identity',
                ErrorCode.GameConfig,
            )
            const bytes = Buffer.from(row.png, 'base64')
            ensure(
                bytes.toString('base64') === row.png &&
                    bytes.length >= 33 &&
                    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
                    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
                    createHash('sha256').update(bytes).digest('hex') === row.sha256 &&
                    Number.isSafeInteger(row.width) &&
                    row.width > 0 &&
                    row.width <= 4096 &&
                    Number.isSafeInteger(row.height) &&
                    row.height > 0 &&
                    row.height <= 4096 &&
                    bytes.readUInt32BE(16) === row.width &&
                    bytes.readUInt32BE(20) === row.height,
                'Gacha artwork PNG integrity mismatch',
                ErrorCode.GameConfig,
            )
            const pathname = '/assets/gacha/' + row.sha256 + '.png'
            this.images.set(row.key, pathname)
            this.files.set(pathname, { bytes, etag: '"' + row.sha256 + '"' })
        }
    }
    urls(baseUrl) {
        let base
        try {
            base = new URL(baseUrl)
        } catch {
            ensure(false, 'Invalid gacha artwork public URL', ErrorCode.GameConfig)
        }
        ensure(
            ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password,
            'Invalid gacha artwork public URL',
            ErrorCode.GameConfig,
        )
        return Object.fromEntries([...this.images].map(([key, pathname]) => [key, new URL(pathname, base).href]))
    }
    respond(req, res, pathname) {
        if (!pathname.startsWith('/assets/gacha/')) return false
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return true
        }
        const file = this.files.get(pathname)
        if (!file) {
            res.writeHead(404)
            res.end()
            return true
        }
        const headers = {
            'content-type': 'image/png',
            'x-content-type-options': 'nosniff',
            'cache-control': 'public, max-age=31536000, immutable',
            etag: file.etag,
        }
        if (req.headers['if-none-match'] === file.etag) {
            res.writeHead(304, headers)
            res.end()
            return true
        }
        res.writeHead(200, { ...headers, 'content-length': file.bytes.length })
        res.end(req.method === 'HEAD' ? undefined : file.bytes)
        return true
    }
}
