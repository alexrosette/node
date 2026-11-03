/* eslint-disable no-console */
// Single-panel node, with (E2E_LEDGER=on) or without (off) the ledger channel.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { buildStartBody, call, deriveSni, loadPanel, makeUser } from './fakepanel.mjs';

const PORT = 2222;
const WITH_LEDGER = process.env.E2E_LEDGER === 'on';
const DIR = new URL('./.data', import.meta.url).pathname;

const state = { failed: 0 };
const ok = (cond, msg, extra) => {
    console.log(
        `${cond ? '  ✅' : '  ❌'} ${msg}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 600) : ''}`,
    );
    if (!cond) state.failed++;
};
const section = (t) => console.log(`\n=== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const panel = loadPanel(1, 'panel1');
const req = (method, path, body, opts) => call(panel, PORT, method, path, body, opts);

const lr = (f) => fs.readFileSync(`${DIR}/ledger/${f}`, 'utf8');
const b64url = (b) => Buffer.from(b).toString('base64url');
const LEDGER_SNI = deriveSni(lr('ca.crt'), lr('jwt.pub'));
const LEDGER_TLS = { cert: lr('client.crt'), key: lr('client.key'), ca: lr('ca.crt') };

function token({ aud = 'rw-node-ledger', ttl = 30, jti = crypto.randomUUID(), key = lr('jwt.key') } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ aud, iat: now, exp: now + ttl, jti }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), key);
    return `${header}.${payload}.${b64url(sig)}`;
}

const ledger = (method, path, body, { jwt = token(), tls = LEDGER_TLS, sni = LEDGER_SNI } = {}) =>
    call({ jwt, tls, sni }, PORT, method, path, body);
const status = async () => (await ledger('GET', '/node/ledger/status')).json?.response;

const dump = () =>
    JSON.parse(
        execFileSync('docker', ['exec', 'rwn', 'node', '/dump.js'], { encoding: 'utf8' }) ||
            '{"inbounds":[]}',
    );
const emails = (cfg, tag) =>
    (cfg.inbounds.find((i) => i.tag === tag)?.settings?.clients ?? []).map((c) => c.email).sort();
const uptime = async () =>
    (await req('GET', '/node/stats/get-system-stats')).json?.response?.xrayInfo?.uptime ?? null;

const users = [makeUser(1, 'a'), makeUser(2, 'a')];
const added = makeUser(3, 'a');

section(`S1. Panel works as upstream (ledger ${WITH_LEDGER ? 'on' : 'off'})`);
{
    ok((await req('GET', '/node/xray/healthcheck')).status === 200, 'panel healthcheck 200');
    ok(
        (await req('GET', '/node/xray/healthcheck', undefined, { sni: 'random.example.com' }))
            .status === 200,
        'panel with any SNI (SNI_VERIFICATION off) still works',
    );

    if (WITH_LEDGER) {
        const early = await ledger('POST', '/node/ledger/core/restart', {});
        ok(
            early.json?.response?.isStarted === false && /not started/.test(early.json?.response?.error ?? ''),
            'ledger restart before the panel started the core → refused, nothing touched',
            early.json ?? early,
        );
        await sleep(10_500); // the refused restart still used the 10 s slot
    }

    const r = await req('POST', '/node/xray/start', buildStartBody(users));
    ok(r.json?.response?.isStarted === true, 'panel start ok', r.json ?? r);
    ok(JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","2"]', 'config has the panel users');
}

section('S2. Users changed through the API are kept in the stored config');
{
    const add = await req('POST', '/node/handler/add-users', {
        affectedInboundTags: ['VLESS_TCP', 'TROJAN_TCP', 'SS_TCP'],
        users: [
            {
                inboundData: [
                    { type: 'vless', tag: 'VLESS_TCP', flow: '' },
                    { type: 'trojan', tag: 'TROJAN_TCP' },
                    { type: 'shadowsocks22', tag: 'SS_TCP' },
                ],
                userData: {
                    userId: '3',
                    hashUuid: added.vlessUuid,
                    vlessUuid: added.vlessUuid,
                    trojanPassword: added.trojanPassword,
                    ssPassword: added.ssPassword,
                },
            },
        ],
    });
    ok(add.json?.response?.success === true, 'add-users ok', add.json ?? add);

    const rm = await req('POST', '/node/handler/remove-user', {
        username: '2',
        hashData: { vlessUuid: users[1].vlessUuid },
    });
    ok(rm.json?.response?.success === true, 'remove-user ok', rm.json ?? rm);

    const one = await req('POST', '/node/handler/add-user', {
        data: [{ type: 'vless', tag: 'VLESS_TCP', username: '4', uuid: makeUser(4, 'a').vlessUuid, flow: '' }],
        hashData: { vlessUuid: makeUser(4, 'a').vlessUuid },
    });
    ok(one.json?.response?.success === true, 'add-user ok', one.json ?? one);

    const cfg = dump();
    ok(JSON.stringify(emails(cfg, 'VLESS_TCP')) === '["1","3","4"]', 'VLESS: 3 and 4 added, 2 removed', emails(cfg, 'VLESS_TCP'));
    ok(JSON.stringify(emails(cfg, 'TROJAN_TCP')) === '["1","3"]', 'Trojan: 3 added, 2 removed', emails(cfg, 'TROJAN_TCP'));
    ok(JSON.stringify(emails(cfg, 'SS_TCP')) === '["1","3"]', 'SS 2022: 3 added, 2 removed', emails(cfg, 'SS_TCP'));
    const vless3 = cfg.inbounds.find((i) => i.tag === 'VLESS_TCP').settings.clients.find((c) => c.email === '3');
    ok(vless3?.id === added.vlessUuid && vless3.flow === undefined, 'VLESS client 3 = {id, email}', vless3);

    const again = await req('POST', '/node/xray/start', buildStartBody([users[0], added, makeUser(4, 'a')]));
    ok(again.json?.response?.isStarted === true, 'panel re-start with the same users → ok', again.json ?? again);
}

if (!WITH_LEDGER) {
    section('S3. No ledger: ledger identity is refused');
    {
        const s = await ledger('GET', '/node/ledger/status');
        ok(s.status !== 200, `ledger cert/SNI without LEDGER_SECRET_KEY → refused (${s.status})`);
        const p = await req('GET', '/node/ledger/status');
        ok(p.status === 404, `panel → /node/ledger/status → 404 (${p.status})`);
    }
} else {
    section('S3. Ledger authorization and route split');
    {
        ok((await ledger('GET', '/node/ledger/status')).status === 200, 'ledger status 200');
        ok(
            (await ledger('GET', '/node/ledger/status', undefined, { tls: { ca: LEDGER_TLS.ca } })).status === 0,
            'no client cert → handshake fails',
        );
        ok(
            (await ledger('GET', '/node/ledger/status', undefined, { tls: panel.tls })).status !== 200,
            'panel client cert on the ledger SNI → refused',
        );
        ok(
            (await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ key: fs.readFileSync(`${DIR}/panel1/jwt.key`, 'utf8') }) })).status !== 200,
            'JWT signed by the panel key → refused',
        );
        const jti = crypto.randomUUID();
        const first = await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ jti }) });
        const replay = await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ jti }) });
        ok(first.status === 200 && replay.status !== 200, `replayed jti refused (${first.status} → ${replay.status})`);
        ok((await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ ttl: 120 }) })).status !== 200, 'exp - iat > 60 → refused');
        ok((await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ aud: 'other' }) })).status !== 200, 'wrong audience → refused');

        ok((await ledger('GET', '/node/xray/healthcheck')).status !== 200, 'ledger → panel route refused');
        ok((await req('GET', '/node/ledger/status')).status === 404, 'panel → ledger route → 404');
        ok((await req('GET', '/node/xray/healthcheck')).status === 200, 'panel keeps working after the refused call');
        for (const [method, path] of [
            ['GET', '/node/ledger/config'],
            ['PUT', '/node/ledger/config'],
            ['POST', '/node/ledger/core/stop'],
            ['POST', '/node/ledger/core/start'],
        ]) {
            const r = await ledger(method, path, {});
            ok(r.status === 404 || r.status === 0, `${method} ${path} → not found (${r.status}): not in this image`);
        }
    }

    section('S4. Ledger status');
    {
        const s = await status();
        ok(s?.xray?.online === true && typeof s.xray.version === 'string' && s.xray.uptimeSec >= 0, 'xray online, version, uptime', s?.xray);
        ok(s?.panel?.connected === true && s.panel.lastStartAt && s.panel.lastRequestAt, 'panel connected, last start and request', s?.panel);
        ok(s?.panel?.users === 3, 'panel users = 3 (1, 3, 4)', s?.panel);
        ok(s?.system?.cpus > 0 && s.system.memTotal > 0 && typeof s.system.load1 === 'number', 'system cpu / load / memory', s?.system);
        ok(s?.base === undefined && s?.panels === undefined, 'no base / panels fields (single panel, config from the panel)');
    }

    section('S5. Ledger restart');
    {
        await sleep(3000);
        const before = await uptime();
        const r = await ledger('POST', '/node/ledger/core/restart', { reason: 'e2e' });
        ok(r.json?.response?.isStarted === true && r.json.response.error === null, 'restart ok', r.json ?? r);
        const after = await uptime();
        ok(after !== null && after < before, `core really restarted (uptime ${before} → ${after})`);
        ok(JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","3","4"]', 'core restarted with the current users');
        const again = await ledger('POST', '/node/ledger/core/restart', {});
        ok(again.status === 429, `second restart within 10 s → 429 (${again.status})`);
        const p = await req('POST', '/node/xray/start', buildStartBody([users[0], added, makeUser(4, 'a')]));
        ok(p.json?.response?.isStarted === true && (await uptime()) >= after, 'panel start after it: up-to-date, no second restart');
    }
}

console.log(`\nSingle-panel (ledger ${WITH_LEDGER ? 'on' : 'off'}) finished, failures: ${state.failed}`);
process.exitCode = state.failed ? 1 : 0;
