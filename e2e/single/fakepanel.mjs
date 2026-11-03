import crypto from 'node:crypto';
/* eslint-disable no-console */
// Minimal imitation of the Remnawave panel -> node protocol, used for e2e testing.
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { HashedSet } = require('@remnawave/hashed-set');

const DIR = new URL('./.data', import.meta.url).pathname;
const b64url = (b) => Buffer.from(b).toString('base64url');

// Same as deriveSni() in the Remnawave panel (src/common/utils/certs/generate-servername.util.ts).
const TLDS = ['com', 'net', 'org', 'io', 'dev', 'app'];
export function deriveSni(caCertPem, jwtPublicKey) {
    const canon = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
    const ikm = Buffer.concat([
        Buffer.from(canon(jwtPublicKey), 'utf8'),
        Buffer.from(canon(caCertPem), 'utf8'),
    ]);
    const okm = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), 'rw-v1', 22));
    return `${okm.subarray(0, 16).toString('hex')}.${okm.subarray(16, 21).toString('hex')}.${TLDS[okm[21] % TLDS.length]}`;
}

export function loadPanel(i, dir = `panel${i}`) {
    const r = (f) => fs.readFileSync(`${DIR}/${dir}/${f}`, 'utf8');
    const secretKey = Buffer.from(
        JSON.stringify({
            nodeCertPem: r('node.crt'),
            nodeKeyPem: r('node.key'),
            caCertPem: r('ca.crt'),
            jwtPublicKey: r('jwt.pub'),
        }),
    ).toString('base64');
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
        JSON.stringify({ uuid: null, username: null, role: 'API', iat: now, exp: now + 86400 }),
    );
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), r('jwt.key'));
    return {
        id: i,
        sni: deriveSni(r('ca.crt'), r('jwt.pub')),
        secretKey,
        jwt: `${header}.${payload}.${b64url(sig)}`,
        tls: { cert: r('client.crt'), key: r('client.key'), ca: r('ca.crt') },
    };
}

export function call(panel, port, method, path, body, { tlsFrom, jwtFrom, sniFrom, sni } = {}) {
    const tls = (tlsFrom ?? panel).tls;
    const jwt = (jwtFrom ?? panel).jwt;
    return new Promise((resolve) => {
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = https.request(
            {
                host: '127.0.0.1',
                port,
                method,
                path,
                ...tls,
                servername: sni ?? (sniFrom ?? panel).sni,
                checkServerIdentity: () => undefined,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.3',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    'Content-Type': 'application/json',
                    ...(data ? { 'Content-Length': data.length } : {}),
                },
                timeout: 60_000,
            },
            (res) => {
                let buf = '';
                res.on('data', (c) => (buf += c));
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(buf);
                    } catch {}
                    resolve({ status: res.statusCode, json, raw: buf });
                });
            },
        );
        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        if (data) req.write(data);
        req.end();
    });
}

export const SS_SERVER_KEY = Buffer.alloc(32, 7).toString('base64');

export function makeUser(id, seed) {
    const h = crypto.createHash('sha256').update(`${seed}-${id}`).digest('hex');
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    return {
        id,
        vlessUuid: uuid,
        trojanPassword: `tp-${h.slice(0, 16)}`,
        ssPassword: h.slice(32, 64), // 32 chars -> 32 bytes for 2022-blake3-aes-256-gcm
        tags: ['VLESS_TCP', 'TROJAN_TCP', 'SS_TCP'],
    };
}

export function buildTemplate() {
    return {
        log: { loglevel: 'warning' },
        inbounds: [
            {
                tag: 'VLESS_TCP',
                port: 10001,
                listen: '0.0.0.0',
                protocol: 'vless',
                settings: { decryption: 'none', clients: [] },
                streamSettings: { network: 'tcp', security: 'none' },
            },
            {
                tag: 'TROJAN_TCP',
                port: 10002,
                listen: '0.0.0.0',
                protocol: 'trojan',
                settings: { clients: [] },
                streamSettings: { network: 'tcp', security: 'none' },
            },
            {
                tag: 'SS_TCP',
                port: 10003,
                listen: '0.0.0.0',
                protocol: 'shadowsocks',
                settings: {
                    method: '2022-blake3-aes-256-gcm',
                    password: SS_SERVER_KEY,
                    network: 'tcp,udp',
                    clients: [],
                },
            },
        ],
        outbounds: [
            {
                tag: 'DIRECT',
                protocol: 'freedom',
                settings: { finalRules: [{ action: 'allow', ip: ['172.16.0.0/12'] }] },
            },
            { tag: 'BLOCK', protocol: 'blackhole' },
        ],
        routing: { rules: [] },
    };
}

// Renders a config exactly like the panel does: users are injected per inbound + hashes.
export function buildStartBody(users, { forceRestart = false, templateMutator } = {}) {
    const config = buildTemplate();
    templateMutator?.(config);
    const emptyConfig = crypto
        .createHash('sha256')
        .update(JSON.stringify(config))
        .digest('hex')
        .slice(0, 16);
    const sets = new Map();
    for (const inbound of config.inbounds) {
        for (const u of users) {
            if (!u.tags.includes(inbound.tag)) continue;
            if (!sets.has(inbound.tag)) sets.set(inbound.tag, new HashedSet());
            sets.get(inbound.tag).add(u.vlessUuid);
            const email = String(u.id);
            if (inbound.protocol === 'vless')
                inbound.settings.clients.push({ id: u.vlessUuid, email });
            if (inbound.protocol === 'trojan')
                inbound.settings.clients.push({
                    password: u.trojanPassword,
                    email,
                    id: u.vlessUuid,
                });
            if (inbound.protocol === 'shadowsocks')
                inbound.settings.clients.push({
                    password: Buffer.from(u.ssPassword).toString('base64'),
                    email,
                    id: u.vlessUuid,
                });
        }
    }
    return {
        internals: {
            forceRestart,
            hashes: {
                emptyConfig,
                inbounds: [...sets].map(([tag, s]) => ({
                    tag,
                    usersCount: s.size,
                    hash: s.hash64String,
                })),
            },
        },
        xrayConfig: config,
    };
}

export function addUsersBody(users) {
    return {
        affectedInboundTags: ['VLESS_TCP', 'TROJAN_TCP', 'SS_TCP'],
        users: users.map((u) => ({
            inboundData: [
                { type: 'vless', tag: 'VLESS_TCP', flow: '' },
                { type: 'trojan', tag: 'TROJAN_TCP' },
                { type: 'shadowsocks22', tag: 'SS_TCP' },
            ],
            userData: {
                userId: String(u.id),
                hashUuid: u.vlessUuid,
                vlessUuid: u.vlessUuid,
                trojanPassword: u.trojanPassword,
                ssPassword: u.ssPassword,
            },
        })),
    };
}
