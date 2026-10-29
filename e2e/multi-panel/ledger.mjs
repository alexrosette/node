/* eslint-disable no-console */
// Ledger control plane: node started with SECRET_KEY + SECRET_KEY_2 (shared port) + LEDGER_SECRET_KEY.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { buildStartBody, buildTemplate, call, deriveSni, makeUser } from './fakepanel.mjs';
import { state, ok, section, sleep, req, dump, emails, sys, uptime, p1Users, p2Users } from './helpers.mjs';

const DIR = new URL('./.data/ledger', import.meta.url).pathname;
const r = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8');
const b64url = (b) => Buffer.from(b).toString('base64url');
const PORT = 2222;

const SNI = deriveSni(r('ca.crt'), r('jwt.pub'));
const TLS = { cert: r('client.crt'), key: r('client.key'), ca: r('ca.crt') };

function token({ aud = 'rw-node-ledger', ttl = 30, jti = crypto.randomUUID(), key = r('jwt.key') } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ aud, iat: now, exp: now + ttl, jti }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), key);
    return `${header}.${payload}.${b64url(sig)}`;
}

const ledger = (method, path, body, { jwt = token(), tls = TLS, sni = SNI } = {}) =>
    call({ jwt, tls, sni }, PORT, method, path, body);

const status = async () => (await ledger('GET', '/node/ledger/status')).json?.response;

const fetchVia = (port) =>
    execFileSync('docker', ['exec', 'rwcli', 'wget', '-T', '8', '-t', '1', '-q', '-O', '/dev/null', `http://127.0.0.1:${port}/`]);
const canFetch = (port) => {
    try {
        fetchVia(port);
        return true;
    } catch {
        return false;
    }
};
const usersStats = async (p, reset) =>
    (await req(p, 'POST', '/node/stats/get-users-stats', { reset })).json?.response?.users;

section('L1. Ledger identity and authorization');
{
    const s = await ledger('GET', '/node/ledger/status');
    ok(s.status === 200 && s.json?.response?.base?.source === 'panel', 'status 200, base from panel', s.json ?? s);
    ok(
        JSON.stringify(s.json?.response?.panels?.map((p) => p.id)) === '[1,2]',
        'ledger is not listed as a panel',
        s.json?.response?.panels,
    );

    ok((await ledger('GET', '/node/ledger/status', undefined, { tls: { ca: TLS.ca } })).status === 0, 'no client cert → handshake fails');
    ok(
        (await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ key: fs.readFileSync(new URL('./.data/panel1/jwt.key', import.meta.url), 'utf8') }) })).status !== 200,
        'foreign JWT key → refused',
    );

    const jti = crypto.randomUUID();
    const first = await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ jti }) });
    const replay = await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ jti }) });
    ok(first.status === 200 && replay.status !== 200, `replayed jti refused (${first.status} → ${replay.status})`);
    ok((await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ ttl: 120 }) })).status !== 200, 'exp - iat > 60 → refused');
    ok((await ledger('GET', '/node/ledger/status', undefined, { jwt: token({ aud: 'other' }) })).status !== 200, 'wrong audience → refused');
    ok((await ledger('GET', '/node/ledger/status', undefined, { jwt: 'x.y.z' })).status !== 200, 'garbage token → refused');
}

section('L2. Routes are split between ledger and panels');
{
    const a = await ledger('GET', '/node/xray/healthcheck');
    ok(a.status === 404 || a.status === 0, `ledger → panel route refused (${a.status})`);
    const b = await req(1, 'GET', '/node/ledger/status');
    ok(b.status === 404 || b.status === 0, `panel → ledger route refused (${b.status})`);
    ok((await req(1, 'GET', '/node/xray/healthcheck')).status === 200, 'panel route still works for panel');
}

section('L3. Panels start, then ledger takes over the base config');
{
    ok((await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users))).json?.response?.isStarted === true, 'panel 1 start');
    ok((await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users))).json?.response?.isStarted === true, 'panel 2 start');

    // Base still from panels: ledger stop keeps the state, panels can't start the core.
    ok((await ledger('POST', '/node/ledger/core/stop', {})).json?.response?.isStopped === true, 'ledger stop (base from panels)');
    ok((await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users))).json?.response?.isStarted === false, 'panel start blocked after ledger stop (base from panels)');
    ok((await ledger('POST', '/node/ledger/core/start', {})).json?.response?.isStarted === true, 'ledger start (base from panels)');
    ok(JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","2","p2.1","p2.3"]', 'core/start brings users of both panels back at once', emails(dump(), 'VLESS_TCP'));

    const bad = buildTemplate();
    bad.inbounds[0].protocol = 'nonsense';
    const before = await uptime();
    const invalid = await ledger('PUT', '/node/ledger/config', { config: bad });
    ok(invalid.status === 422 && /nonsense/.test(invalid.json?.output ?? ''), 'invalid config → 422 with xray output', invalid.json ?? invalid);
    ok((await uptime()) >= before, 'core untouched by invalid config');

    const conflict = await ledger('PUT', '/node/ledger/config', { config: buildTemplate(), baseHash: 'deadbeef' });
    ok(conflict.status === 409, 'wrong baseHash → 409', conflict.json ?? conflict);

    const base = buildTemplate();
    base.log.loglevel = 'error'; // differs from the panels' base
    const put = await ledger('PUT', '/node/ledger/config', { config: base, baseHash: (await status()).base.hash });
    ok(put.status === 200 && put.json?.response?.isStarted === true, 'PUT config applied', put.json ?? put);

    const expectedHash = crypto
        .createHash('sha256')
        .update(execFileSync('python3', ['-c', 'import json,sys;print(json.dumps(json.load(sys.stdin),sort_keys=True,ensure_ascii=False),end="")'], { input: JSON.stringify(base) }))
        .digest('hex');
    ok(put.json?.response?.hash === expectedHash, 'hash = sha256(python json.dumps(sort_keys=True))', put.json?.response?.hash);

    const got = await ledger('GET', '/node/ledger/config');
    ok(got.json?.response?.hash === expectedHash && got.json?.response?.config?.log?.loglevel === 'error', 'GET config returns the ledger base');
    ok(dump().log?.loglevel === 'error', 'running core uses the ledger base');
    ok(JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","2","p2.1","p2.3"]', 'users of both panels kept', emails(dump(), 'VLESS_TCP'));
    ok(canFetch(9001) && canFetch(9003), 'traffic of both panels goes through');
    ok((await status()).base.source === 'ledger', 'status: base.source = ledger');
}

section('L4. Panels only bring users');
{
    const up0 = await uptime();
    const differentBase = (cfg) => (cfg.log.loglevel = 'debug');
    const r1 = await req(1, 'POST', '/node/xray/start', buildStartBody([...p1Users, { ...p1Users[0], id: 7, vlessUuid: crypto.randomUUID() }], { templateMutator: differentBase }));
    ok(r1.json?.response?.isStarted === true, 'panel 1 start with another base → ok');
    ok((await uptime()) >= up0, 'core not restarted');
    ok(emails(dump(), 'VLESS_TCP').includes('7'), 'new user of panel 1 hot-synced');
    ok(dump().log?.loglevel === 'error', 'base of the panel ignored');

    const r2 = await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users, { forceRestart: true }));
    ok(r2.json?.response?.isStarted === true && (await uptime()) >= up0, 'forceRestart from a panel ignored');

    await req(1, 'GET', '/node/xray/stop');
    await req(2, 'GET', '/node/xray/stop');
    // Panels that stopped get failed system stats (the node has none of their users), so ask ledger.
    const st = await status();
    ok(st.xray.online === true && st.xray.uptimeSec >= up0, 'stop of the last panel keeps the core running', st.xray);
    ok((await sys(1))?.xrayInfo == null, 'stopped panel gets failed system stats');
    ok(emails(dump(), 'VLESS_TCP').length === 0, 'no users left');

    await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
    ok((await uptime()) >= up0 && JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","2","p2.1","p2.3"]', 'panels re-attached without restart');
}

section('L5. Ledger restart: panels never see the node down, traffic is kept');
{
    await sleep(10_500); // rate limit after PUT config
    for (const p of [1, 2]) await usersStats(p, true);
    fetchVia(9001);

    let polls = 0;
    let failures = 0;
    let running = true;
    const poller = (async () => {
        while (running) {
            for (const p of [1, 2]) {
                const s = await req(p, 'GET', '/node/stats/get-system-stats');
                polls++;
                if (s.status !== 200 || !s.json?.response?.xrayInfo) failures++;
            }
            await sleep(100);
        }
    })();

    await sleep(300);
    const restart = await ledger('POST', '/node/ledger/core/restart', { reason: 'e2e' });
    await sleep(1000);
    running = false;
    await poller;

    ok(restart.json?.response?.isStarted === true, `restart ok (${restart.json?.response?.tookMs} ms)`, restart.json ?? restart);
    ok(polls > 10 && failures === 0, `${polls} get-system-stats polls during restart, ${failures} failures`);
    ok((await uptime()) < 10, 'core really restarted');

    const s1 = await usersStats(1, true);
    const one = s1?.find((x) => x.username === '1');
    ok(one && one.downlink >= 2_900_000, `traffic from before the restart kept (${one?.downlink} B)`, s1);

    const again = await ledger('POST', '/node/ledger/core/restart', {});
    ok(again.status === 429, 'second restart within 10 s → 429', again.json ?? again);
}

section('L6. Ledger stop / start');
{
    const stop = await ledger('POST', '/node/ledger/core/stop', {});
    ok(stop.json?.response?.isStopped === true, 'core stopped');
    const s = await req(1, 'GET', '/node/stats/get-system-stats');
    ok(s.status !== 200 || !s.json?.response?.xrayInfo, 'panels see the truth: core is down');
    const us = await req(1, 'POST', '/node/stats/get-users-stats', { reset: true });
    ok(!Array.isArray(us.json?.response?.users), 'users stats fail instead of an empty list while the core is down', us.json ?? us);
    const ps = await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    ok(ps.json?.response?.isStarted === false, 'panel cannot start a core stopped by ledger', ps.json);

    const start = await ledger('POST', '/node/ledger/core/start', {});
    ok(start.json?.response?.isStarted === true, 'ledger starts the core', start.json ?? start);
    ok((await sys(1))?.xrayInfo != null, 'panels see it online again');
    ok(canFetch(9001) && canFetch(9003), 'users of both panels served right after core/start');
    await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
    ok(canFetch(9001) && canFetch(9003), 'users of both panels back after re-start');
}

section('L7. Container restart: core comes up with the saved base before panels');
{
    execFileSync('docker', ['restart', 'rwn']);
    let st = null;
    for (let i = 0; i < 40 && !st?.xray?.online; i++) {
        await sleep(500);
        st = await status();
    }
    ok(st?.xray?.online === true && st?.base?.source === 'ledger', 'core online with the ledger base', st);
    ok(st?.panels?.every((p) => p.users === 0), 'no panel users yet');
    execFileSync('docker', ['cp', new URL('./dump.js', import.meta.url).pathname, 'rwn:/dump.js']);
    ok(dump().log?.loglevel === 'error', 'running core uses the saved base');
    await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    ok(canFetch(9001), 'panel 1 users served after its start');
    const perms = execFileSync('docker', ['exec', 'rwn', 'stat', '-c', '%a', '/var/lib/remnanode', '/var/lib/remnanode/base-config.json'], { encoding: 'utf8' }).split('\n');
    ok(perms[0] === '700' && perms[1] === '600', `state dir 0700, file 0600 (${perms.join(' ').trim()})`);
}

section('L8. Big panels: VLESS hot sync without restart, Shadowsocks above the cost limit restarts');
{
    await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
    const up0 = await uptime();
    const vless = Array.from({ length: 60_000 }, (_, i) => ({ ...makeUser(i + 100, 'big'), tags: ['VLESS_TCP'] }));
    const t = performance.now();
    const r = await req(2, 'POST', '/node/xray/start', buildStartBody(vless));
    const sec = (performance.now() - t) / 1000;
    ok(r.json?.response?.isStarted === true && (await uptime()) >= up0, `60k VLESS users hot-synced without restart (${sec.toFixed(1)} s)`);
    ok(canFetch(9001), 'panel 1 user kept its connection path during the big sync');

    const ss = Array.from({ length: 6_000 }, (_, i) => ({ ...makeUser(i + 100, 'ss'), tags: ['SS_TCP'] }));
    const up1 = await uptime();
    const r2 = await req(2, 'POST', '/node/xray/start', buildStartBody(ss));
    const up2 = await uptime();
    ok(r2.json?.response?.isStarted === true && up2 < up1, `6k Shadowsocks users → restart instead of a slow hot sync (uptime ${up1} → ${up2})`);
    await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
}

console.log(`\nLedger finished, failures: ${state.failed}`);
process.exitCode = state.failed ? 1 : 0;
