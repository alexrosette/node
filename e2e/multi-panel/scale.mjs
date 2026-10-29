/* eslint-disable no-console */
// 20 panels on ONE port (SNI routing), same user ids on every panel, different traffic per
// panel, all panels polling the node concurrently — the way it happens in production.
//   node scale.mjs client   → writes .data/client20.json for the xray client container
//   node scale.mjs          → runs the scenario
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { buildStartBody, call, loadPanel, makeUser } from './fakepanel.mjs';

const N = 20;
const PORT = 2222;
const USERS_PER_PANEL = 5;
const MB3 = 3_000_000;
// run.sh starts the node with STATS_DRAIN_INTERVAL_MS=500
const DRAIN_WAIT_MS = 1500;
// panel → which of its users downloads and how many times (3 MB each)
const TRAFFIC = [
    { panel: 1, user: 1, times: 1, port: 9101 },
    { panel: 7, user: 2, times: 2, port: 9102 },
    { panel: 13, user: 3, times: 3, port: 9103 },
    { panel: 20, user: 4, times: 4, port: 9104 },
];

const usersOf = (k) =>
    Array.from({ length: USERS_PER_PANEL }, (_, i) => makeUser(i + 1, `scale-${k}`));

if (process.argv[2] === 'client') {
    const config = {
        log: { loglevel: 'warning' },
        inbounds: TRAFFIC.map((t) => ({
            tag: `in${t.panel}`,
            listen: '127.0.0.1',
            port: t.port,
            protocol: 'dokodemo-door',
            settings: { address: 'rwweb', port: 8080, network: 'tcp' },
        })),
        outbounds: TRAFFIC.map((t) => ({
            tag: `out${t.panel}`,
            protocol: 'vless',
            settings: {
                vnext: [
                    {
                        address: 'rwn',
                        port: 10001,
                        users: [{ id: usersOf(t.panel)[t.user - 1].vlessUuid, encryption: 'none' }],
                    },
                ],
            },
        })),
        routing: {
            rules: TRAFFIC.map((t) => ({
                type: 'field',
                inboundTag: [`in${t.panel}`],
                outboundTag: `out${t.panel}`,
            })),
        },
    };
    fs.writeFileSync(new URL('./.data/client20.json', import.meta.url), JSON.stringify(config));
    process.exit(0);
}

let failed = 0;
const ok = (cond, msg, extra) => {
    console.log(
        `${cond ? '  ✅' : '  ❌'} ${msg}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''}`,
    );
    if (!cond) failed++;
};

const P = Object.fromEntries(Array.from({ length: N }, (_, i) => [i + 1, loadPanel(i + 1)]));
const req = (k, method, path, body) => call(P[k], PORT, method, path, body);
const panels = Object.keys(P).map(Number);
const uptime = async () =>
    (await req(1, 'GET', '/node/stats/get-system-stats')).json?.response?.xrayInfo?.uptime;
const dump = () =>
    JSON.parse(execFileSync('docker', ['exec', 'rwn', 'node', '/dump.js'], { encoding: 'utf8' }));
const fetchVia = (port) =>
    execFileSync('docker', [
        'exec',
        'rwcli20',
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

console.log(`\n=== ${N} panels on one port`);
{
    const logs = execFileSync('docker', ['logs', 'rwn'], { encoding: 'utf8' });
    ok(
        (logs.match(/\(shared, SNI\)/g) ?? []).length === N,
        `node lists ${N} panels on shared port`,
    );

    const first = await req(1, 'POST', '/node/xray/start', buildStartBody(usersOf(1)));
    ok(first.json?.response?.isStarted === true, 'panel #1 starts the core', first.json ?? first);
    const up0 = await uptime();

    const starts = await Promise.all(
        panels.slice(1).map((k) => req(k, 'POST', '/node/xray/start', buildStartBody(usersOf(k)))),
    );
    ok(
        starts.every((r) => r.json?.response?.isStarted === true),
        `${N - 1} more panels joined concurrently`,
    );
    ok((await uptime()) >= up0, 'core was not restarted while panels joined');

    const clients = dump()
        .inbounds.find((i) => i.tag === 'VLESS_TCP')
        .settings.clients.map((c) => c.email);
    ok(
        clients.length === N * USERS_PER_PANEL && new Set(clients).size === clients.length,
        `${clients.length} unique users in Xray (ids 1..5 on every panel)`,
    );
}

console.log('\n=== Traffic: concurrent polling by all panels');
{
    await Promise.all(
        panels.map((k) => req(k, 'POST', '/node/stats/get-users-stats', { reset: true })),
    );
    await Promise.all(
        panels.map((k) => req(k, 'POST', '/node/stats/get-combined-stats', { reset: true })),
    );

    for (const t of TRAFFIC) for (let i = 0; i < t.times; i++) fetchVia(t.port);
    await new Promise((r) => setTimeout(r, 1500));

    // Every panel polls users and node usage at the same time, interleaved.
    const results = await Promise.all(
        panels.map(async (k) => {
            const [users, combined] = await Promise.all([
                req(k, 'POST', '/node/stats/get-users-stats', { reset: true }),
                req(k, 'POST', '/node/stats/get-combined-stats', { reset: true }),
            ]);
            return { k, users: users.json?.response?.users, combined: combined.json?.response };
        }),
    );

    const nodeUsage = (c) => (c?.outbounds ?? []).reduce((a, o) => a + o.uplink + o.downlink, 0);
    let totalUsers = 0;
    let totalNode = 0;
    const rows = [];

    for (const { k, users, combined } of results) {
        const t = TRAFFIC.find((x) => x.panel === k);
        const usersBytes = (users ?? []).reduce((a, u) => a + u.uplink + u.downlink, 0);
        const node = nodeUsage(combined);
        totalUsers += usersBytes;
        totalNode += node;
        rows.push(`#${k}:${(node / 1e6).toFixed(2)}MB`);

        if (t) {
            const own = users?.find((u) => u.username === String(t.user));
            ok(
                users?.length === 1 &&
                    own &&
                    own.downlink >= t.times * MB3 &&
                    own.downlink < t.times * MB3 * 1.01,
                `panel #${k}: only its user "${t.user}" with ${t.times}×3 MB (${own?.downlink} B)`,
                users,
            );
            ok(
                Math.abs(node - usersBytes) <= usersBytes * 0.03,
                `panel #${k}: node usage = its users traffic (${node} vs ${usersBytes})`,
            );
        } else if ((users ?? []).length !== 0 || node > 50_000) {
            ok(false, `panel #${k} without traffic got users=${users?.length} node=${node} B`);
        }
    }

    ok(true, `panels without traffic: ${N - TRAFFIC.length} × 0 users, node usage ≤ 50 KB each`);
    console.log(`     node usage per panel: ${rows.join(' ')}`);
    ok(
        Math.abs(totalNode - totalUsers) <= totalUsers * 0.02,
        `sum over ${N} panels = real traffic (${totalNode} vs ${totalUsers})`,
    );
}

console.log('\n=== Stats are answered from the buffers: latency does not grow with panels');
{
    const timed = async (k) => {
        const t = performance.now();
        const [users, combined] = await Promise.all([
            req(k, 'POST', '/node/stats/get-users-stats', { reset: true }),
            req(k, 'POST', '/node/stats/get-combined-stats', { reset: true }),
        ]);
        return {
            ms: performance.now() - t,
            ok: Array.isArray(users.json?.response?.users) && Array.isArray(combined.json?.response?.inbounds),
        };
    };

    const single = [];
    for (let i = 0; i < 5; i++) single.push((await timed(1)).ms);

    const rounds = [];
    let allOk = true;
    for (let i = 0; i < 5; i++) {
        const res = await Promise.all(panels.map((k) => timed(k)));
        allOk &&= res.every((r) => r.ok);
        rounds.push(Math.max(...res.map((r) => r.ms)));
    }

    const fmt = (xs) => xs.map((x) => x.toFixed(0)).join('/');
    console.log(`     1 panel: ${fmt(single)} ms · ${N} panels at once (max per round): ${fmt(rounds)} ms`);
    ok(allOk, `${N}×5 concurrent polls answered`);
    ok(Math.max(...rounds) < 1000, `${N} panels polling at the same moment are answered within 1 s`);

    // Traffic that arrives between polls shows up after one background drain.
    for (const t of TRAFFIC) fetchVia(t.port);
    await new Promise((r) => setTimeout(r, DRAIN_WAIT_MS));
    const later = await Promise.all(
        TRAFFIC.map((t) => req(t.panel, 'POST', '/node/stats/get-users-stats', { reset: true })),
    );
    ok(
        later.every((r, i) =>
            r.json?.response?.users?.find((u) => u.username === String(TRAFFIC[i].user))?.downlink >= MB3 * 0.97,
        ),
        'new traffic is in the buffers after one drain interval',
    );
}

console.log(`\nfailures: ${failed}`);
process.exitCode = failed ? 1 : 0;
