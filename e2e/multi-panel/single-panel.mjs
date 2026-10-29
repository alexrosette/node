/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';

import { buildStartBody, addUsersBody } from './fakepanel.mjs';
import { state, ok, section, sleep, req, dump, emails, uptime, u, p1Users } from './helpers.mjs';
section('Single-panel regression');
const r = await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users));
ok(r.json?.response?.isStarted === true, 'start ok', r.json ?? r);
ok(
    JSON.stringify(emails(dump(), 'VLESS_TCP')) === '["1","2"]',
    'users are NOT prefixed',
    emails(dump(), 'VLESS_TCP'),
);
const b = await uptime();
ok(
    (await req(1, 'POST', '/node/xray/start', buildStartBody(p1Users))).json?.response
        ?.isStarted === true && (await uptime()) >= b,
    'same hashes → no restart',
);
ok(
    (await req(1, 'POST', '/node/handler/add-users', addUsersBody([u(9, 'a')]))).json?.response
        ?.success === true,
    'add-users ok',
);
ok(emails(dump(), 'VLESS_TCP').includes('9'), 'user 9 added');
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
    'http://127.0.0.1:9001/',
]);
await sleep(1500); // one background stats drain
const s = (await req(1, 'POST', '/node/stats/get-users-stats', { reset: true })).json?.response
    ?.users;
ok(s?.find((x) => x.username === '1')?.downlink >= 2_900_000, 'traffic counted', s);
ok(
    (await req(2, 'GET', '/node/xray/healthcheck', undefined, { port: 1 })).status === 0,
    'foreign panel rejected',
);
const st = await req(1, 'GET', '/node/xray/stop');
ok(st.status === 200, 'stop ok');
const ss = await req(1, 'GET', '/node/stats/get-system-stats');
ok(ss.status !== 200 || ss.json?.response?.xrayInfo == null, 'core stopped');
console.log(`\nfailures: ${state.failed}`);
process.exitCode = state.failed ? 1 : 0;
