import {
    createHash,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
} from 'node:crypto'

const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const DOMAIN = Buffer.from('manjuu/gate-handshake/v3', 'ascii')

function bytes32(value, name) {
    if (!(value instanceof Uint8Array) || value.length !== 32) throw Error(`Invalid Gate ${name} length`)
    return Buffer.from(value)
}

// Current GateEcdhHandshake06031783 hashes a fixed 94-byte transcript, including reserved zeros.
export function deriveGateMaterial(sharedSecret, clientPublicKey, serverPublicKey) {
    const secret = bytes32(sharedSecret, 'shared secret')
    try {
        const client = bytes32(clientPublicKey, 'client public key')
        const server = bytes32(serverPublicKey, 'server public key')
        const transcript = Buffer.alloc(94)
        transcript[1] = DOMAIN.length
        DOMAIN.copy(transcript, 2)
        transcript[29] = 3
        client.copy(transcript, 30)
        server.copy(transcript, 62)
        const salt = createHash('sha256').update(transcript).digest()
        return Buffer.concat(
            ['c2s', 's2c'].map((direction) =>
                Buffer.from(hkdfSync('sha256', secret, salt, `manjuu/gate/v3/${direction}`, 20)),
            ),
        )
    } finally {
        secret.fill(0)
    }
}

// The connection owns caching this result: a repeated hello must not generate a new key or reset GCM usage.
export function createGateServerHandshake(clientPublicKey, { cryptoVersion = 3, privateKey } = {}) {
    if (cryptoVersion !== 3) throw Error('Unsupported Gate crypto version')
    const client = bytes32(clientPublicKey, 'client public key')
    let serverPrivate
    if (privateKey === undefined) {
        serverPrivate = generateKeyPairSync('x25519').privateKey
    } else {
        const raw = bytes32(privateKey, 'private key')
        const der = Buffer.concat([PRIVATE_PREFIX, raw])
        try {
            serverPrivate = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
        } finally {
            raw.fill(0)
            der.fill(0)
        }
    }
    const serverPublicKey = Buffer.from(
        createPublicKey(serverPrivate).export({ format: 'der', type: 'spki' }).subarray(-32),
    )
    const peer = createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, client]), format: 'der', type: 'spki' })
    const secret = diffieHellman({ privateKey: serverPrivate, publicKey: peer })
    try {
        return { serverPublicKey, material: deriveGateMaterial(secret, client, serverPublicKey) }
    } finally {
        secret.fill(0)
    }
}
