/* eslint-disable no-console */
import { buildStartBody, addUsersBody } from './fakepanel.mjs';
import {
    state,
    PORTS,
    P,
    ok,
    section,
    sleep,
    req,
    dump,
    emails,
    uptime,
    u,
    p1Users,
    p2Users,
    p3Users,
} from './helpers.mjs';

section('1. Auth isolation');
{
    const h1 = await req(1, 'GET', '/node/xray/healthcheck');
    ok(h1.status === 200, 'panel 1 reaches its port', h1);
    const h2 = await req(2, 'GET', '/node/xray/healthcheck');
    ok(h2.status === 200, 'panel 2 reaches its port', h2);
    const h3 = await req(3, 'GET', '/node/xray/healthcheck');
    ok(h3.status === 200, 'panel 3 reaches its port', h3);
    // Panel 2 client certificate, presented as panel 1 (port + SNI of panel 1).
    const wrongTls = await req(2, 'GET', '/node/xray/healthcheck', undefined, {
        port: 1,
        sniFrom: P[1],
    });
    ok(wrongTls.status === 0, 'panel 2 mTLS is rejected as panel 1', wrongTls);
    if (PORTS[1] === PORTS[2]) {
        const unknownSni = await req(1, 'GET', '/node/xray/healthcheck', undefined, {
            sni: 'evil.example.com',
        });
        ok(unknownSni.status === 0, 'unknown SNI is rejected on the shared port', unknownSni);
        const p2AsP3 = await req(2, 'GET', '/node/xray/healthcheck', undefined, { sniFrom: P[3] });
        ok(p2AsP3.status === 0, 'panel 2 cert with panel 3 SNI is rejected', p2AsP3);
    }
    const wrongJwt = await req(1, 'GET', '/node/xray/healthcheck', undefined, { jwtFrom: P[2] });
    ok(wrongJwt.status !== 200, 'panel 1 TLS + panel 2 JWT is rejected', wrongJwt);
}

section('2. Panel 1 starts the core');
{
    const r = await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    ok(r.json?.response?.isStarted === true, 'panel 1 start → isStarted', r.json ?? r);
    const cfg = dump();
    ok(
        JSON.stringify(emails(cfg, 'VLESS_TCP')) === JSON.stringify(['1', '2']),
        'VLESS clients = [1,2]',
        emails(cfg, 'VLESS_TCP'),
    );
}

section('3. Panel 2 joins (same ids!) → hot sync, no restart');
let up0 = await uptime();
await sleep(2100);
{
    const r = await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
    ok(r.json?.response?.isStarted === true, 'panel 2 start → isStarted', r.json ?? r);
    const cfg = dump();
    for (const tag of ['VLESS_TCP', 'TROJAN_TCP', 'SS_TCP']) {
        ok(
            JSON.stringify(emails(cfg, tag)) === JSON.stringify(['1', '2', 'p2.1', 'p2.3']),
            `${tag} = [1,2,p2.1,p2.3]`,
            emails(cfg, tag),
        );
    }
    const up1 = await uptime();
    ok(
        up1 !== null && up0 !== null && up1 > up0,
        `core was NOT restarted (uptime ${up0} → ${up1})`,
    );
}

section('4. Panel 3 joins');
{
    const r = await req(3, 'POST', '/node/xray/start', buildStartBody(p3Users));
    ok(r.json?.response?.isStarted === true, 'panel 3 start → isStarted', r.json ?? r);
    ok(emails(dump(), 'VLESS_TCP').includes('p3.5'), 'p3.5 present');
}

section('5. Repeated start with same users → no-op');
{
    const before = await uptime();
    const r = await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
    ok(r.json?.response?.isStarted === true, 'panel 1 start again → isStarted');
    const after = await uptime();
    ok(after >= before, `no restart (uptime ${before} → ${after})`);
}

section('6. Panel 2 add / remove users through API');
{
    const u7 = u(7, 'b');
    const add = await req(2, 'POST', '/node/handler/add-users', addUsersBody([u7]));
    ok(add.json?.response?.success === true, 'add-users ok', add.json ?? add);
    let cfg = dump();
    ok(
        emails(cfg, 'VLESS_TCP').includes('p2.7') && emails(cfg, 'SS_TCP').includes('p2.7'),
        'p2.7 in served config (lazy rebuild)',
        emails(cfg, 'VLESS_TCP'),
    );

    const rm = await req(2, 'POST', '/node/handler/remove-user', {
        username: '1',
        hashData: { vlessUuid: p2Users[0].vlessUuid },
    });
    ok(rm.json?.response?.success === true, 'remove-user ok', rm.json ?? rm);
    cfg = dump();
    ok(!emails(cfg, 'VLESS_TCP').includes('p2.1'), 'p2.1 removed');
    ok(emails(cfg, 'VLESS_TCP').includes('1'), 'panel 1 user "1" untouched');

    const before = await uptime();
    const r = await req(2, 'POST', '/node/xray/start', buildStartBody([p2Users[1], u7]));
    ok(r.json?.response?.isStarted === true, 'panel 2 start with its current users → isStarted');
    ok((await uptime()) >= before, 'hash matches → no restart');
}

section('7. Per-panel online / ip endpoints');
{
    const r = await req(2, 'POST', '/node/stats/get-user-online-status', { username: '3' });
    ok(
        r.status === 200 || r.status === 201,
        'online status endpoint works for panel 2',
        r.json ?? r,
    );
    const ips = await req(1, 'GET', '/node/stats/get-users-ip-list');
    ok(ips.status === 200, 'users ip list works', ips.json ?? ips);
}

console.log(`\nPart A finished, failures: ${state.failed}`);
process.exitCode = state.failed ? 1 : 0;
