/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';

import { loadPanel, call, makeUser } from './fakepanel.mjs';

export const PORTS = { 1: 2222, 2: 2223, 3: 2224 };
export const P = { 1: loadPanel(1), 2: loadPanel(2), 3: loadPanel(3) };
export const state = { failed: 0 };
export const ok = (cond, msg, extra) => {
    console.log(
        `${cond ? '  ✅' : '  ❌'} ${msg}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 600) : ''}`,
    );
    if (!cond) state.failed++;
};
export const section = (t) => console.log(`\n=== ${t}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const req = (p, method, path, body, opts) =>
    call(P[p], PORTS[opts?.port ?? p], method, path, body, opts);

export const dump = () =>
    JSON.parse(
        execFileSync('docker', ['exec', 'rwn', 'node', '/dump.js'], { encoding: 'utf8' }) ||
            '{"inbounds":[]}',
    );
export const emails = (cfg, tag) =>
    (cfg.inbounds.find((i) => i.tag === tag)?.settings?.clients ?? []).map((c) => c.email).sort();
export const sys = async (p = 1) =>
    (await req(p, 'GET', '/node/stats/get-system-stats')).json?.response;
export const uptime = async (p = 1) => (await sys(p))?.xrayInfo?.uptime ?? null;

export const u = (id, seed) => makeUser(id, seed);
export const p1Users = [u(1, 'a'), u(2, 'a')];
export const p2Users = [u(1, 'b'), u(3, 'b')];
export const p3Users = [u(5, 'c')];
