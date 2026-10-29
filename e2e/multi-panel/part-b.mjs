/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';

import { buildStartBody } from './fakepanel.mjs';
import {
    state,
    ok,
    section,
    sleep,
    req,
    dump,
    emails,
    uptime,
    p1Users,
    p2Users,
} from './helpers.mjs';

const fetchVia = (port) =>
    execFileSync('docker', [
        'exec',
        'rwcli',
        'wget',
        '-T',
        '8',
        '-t',
        '1',
        '-q',
        '-O',
        '/dev/null',
        `http://127.0.0.1:${port}/`,
    ]);
const usersStats = async (p, reset) =>
    (await req(p, 'POST', '/node/stats/get-users-stats', { reset })).json?.response?.users;
const combined = async (p, reset) =>
    (await req(p, 'POST', '/node/stats/get-combined-stats', { reset })).json?.response;
const MB3 = 2_900_000;

section('8. Traffic accounting is split per panel');
{
    for (const p of [1, 2, 3]) {
        await usersStats(p, true);
        await combined(p, true);
    }

    fetchVia(9001); // panel 1, user "1"
    fetchVia(9003); // panel 2, user "3"
    fetchVia(9003);
    await sleep(1500);

    const s1 = await usersStats(1, true);
    const one = s1?.find((x) => x.username === '1');
    ok(one && one.downlink >= MB3, `panel 1 sees user "1" traffic (${one?.downlink} B down)`, s1);
    ok(
        !s1?.some((x) => x.username === '3' || x.username.startsWith('p')),
        'panel 1 does not see other panels users',
        s1,
    );

    const s3 = await usersStats(3, true);
    ok(Array.isArray(s3) && s3.length === 0, 'panel 3 sees no user traffic', s3);

    const s2a = await usersStats(2, false);
    const three = s2a?.find((x) => x.username === '3');
    ok(
        three && three.downlink >= 2 * MB3,
        `panel 2 sees its user "3" without prefix (${three?.downlink} B), even though panel 1 already reset`,
        s2a,
    );
    const s2b = await usersStats(2, true);
    ok(
        s2b?.find((x) => x.username === '3')?.downlink === three?.downlink,
        'reset:false did not lose data',
    );
    const s2c = await usersStats(2, true);
    ok(Array.isArray(s2c) && s2c.length === 0, 'after reset panel 2 buffer is empty', s2c);
    const s1b = await usersStats(1, true);
    ok(Array.isArray(s1b) && s1b.length === 0, 'panel 1 buffer is empty after its reset', s1b);

    // Node usage (what the panel records as node traffic = sum of outbounds) must follow
    // the traffic of the panel's own users; the sum over all panels is the real traffic.
    const sumOut = (c) => (c?.outbounds ?? []).reduce((acc, o) => acc + o.uplink + o.downlink, 0);
    const vlessDown = (c) => c?.inbounds?.find((i) => i.inbound === 'VLESS_TCP')?.downlink ?? 0;

    const c1 = await combined(1, true);
    const c2 = await combined(2, true);
    const c3 = await combined(3, true);

    const user1 = one.uplink + one.downlink;
    const user3 = three.uplink + three.downlink;
    const n1 = sumOut(c1);
    const n2 = sumOut(c2);
    const n3 = sumOut(c3);
    const total = n1 + n2 + n3;

    console.log(
        `     node usage: panel1=${n1} panel2=${n2} panel3=${n3} (users: ${user1} / ${user3} / 0)`,
    );

    ok(
        Math.abs(n1 - user1) <= user1 * 0.05,
        `panel 1 node usage ≈ its users traffic (${n1} vs ${user1})`,
    );
    ok(
        Math.abs(n2 - user3) <= user3 * 0.05,
        `panel 2 node usage ≈ its users traffic (${n2} vs ${user3})`,
    );
    ok(n3 <= total * 0.01, `panel 3 (no traffic) gets ~nothing (${n3} B)`);
    ok(n2 > n1 * 1.8, 'panel 2 consumed ~2x more than panel 1');
    ok(
        vlessDown(c1) + vlessDown(c2) + vlessDown(c3) >= 3 * MB3 * 0.99,
        `inbound traffic is not lost: sum over panels = ${vlessDown(c1) + vlessDown(c2) + vlessDown(c3)} B`,
    );
    ok(
        Math.abs(total - (user1 + user3)) <= (user1 + user3) * 0.05,
        `sum over panels ≈ real node traffic (${total} vs ${user1 + user3})`,
    );
}

section('9. Panel 2 stops → only its users are detached');
{
    const before = await uptime();
    const r = await req(2, 'GET', '/node/xray/stop');
    ok(
        r.json?.response?.isStopped === true ||
            r.json?.response?.success === true ||
            r.status === 200,
        'stop ok',
        r.json ?? r,
    );
    const cfg = dump();
    ok(
        !emails(cfg, 'VLESS_TCP').some((e) => e.startsWith('p2.')),
        'no p2.* users left',
        emails(cfg, 'VLESS_TCP'),
    );
    ok(
        emails(cfg, 'VLESS_TCP').includes('1') && emails(cfg, 'VLESS_TCP').includes('p3.5'),
        'panel 1 and 3 users kept',
    );
    const after = await uptime();
    ok(after !== null && after >= before, `core kept running (uptime ${before} → ${after})`);
    let failedFetch = false;
    try {
        fetchVia(9003);
    } catch {
        failedFetch = true;
    }
    ok(failedFetch, 'detached panel 2 user can no longer connect');
    fetchVia(9001);
    ok(true, 'panel 1 user still connects');
}

section('10. Force restart from panel 1 keeps users of panel 3');
{
    const r = await req(
        1,
        'POST',
        '/node/xray/start',
        buildStartBody(p1Users, { forceRestart: true }),
    );
    ok(r.json?.response?.isStarted === true, 'force restart ok', r.json ?? r);
    const up = await uptime();
    ok(up !== null && up < 5, `core restarted (uptime ${up})`);
    const cfg = dump();
    ok(
        JSON.stringify(emails(cfg, 'VLESS_TCP')) === JSON.stringify(['1', '2', 'p3.5']),
        'config = [1,2,p3.5]',
        emails(cfg, 'VLESS_TCP'),
    );
}

section('11. Last panel stop really stops the core');
{
    await req(1, 'GET', '/node/xray/stop');
    ok(
        JSON.stringify(emails(dump(), 'VLESS_TCP')) === JSON.stringify(['p3.5']),
        'after panel 1 stop only p3.5 left',
    );
    ok((await uptime(3)) !== null, 'core still running for panel 3');
    await req(3, 'GET', '/node/xray/stop');
    const s = await req(3, 'GET', '/node/stats/get-system-stats');
    ok(s.status !== 200 || s.json?.response?.xrayInfo == null, 'core is stopped', s.json ?? s);
}

section('12. Fresh start by panel 2 only');
{
    const r = await req(2, 'POST', '/node/xray/start', buildStartBody(p2Users));
    ok(r.json?.response?.isStarted === true, 'panel 2 start ok', r.json ?? r);
    ok(
        JSON.stringify(emails(dump(), 'VLESS_TCP')) === JSON.stringify(['p2.1', 'p2.3']),
        'config = [p2.1,p2.3]',
        emails(dump(), 'VLESS_TCP'),
    );
    fetchVia(9003);
    await sleep(1500); // one background stats drain
    const s2 = await usersStats(2, true);
    ok(
        s2?.some((x) => x.username === '3'),
        'panel 2 user traffic counted',
        s2,
    );
}

console.log(`\nPart B finished, failures: ${state.failed}`);
process.exitCode = state.failed ? 1 : 0;
