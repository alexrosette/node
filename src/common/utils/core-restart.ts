/**
 * Planned Xray Core restart, done by the node itself (ledger, or a panel sent a new config
 * or forceRestart). While it lasts, the core does not answer for a second or two; panels
 * polling the node must not see that as the node going offline.
 *
 * Only restarts the node started itself are covered. A restart that takes longer than
 * RESTART_GRACE_MS is reported honestly, and so is a core stopped on purpose.
 */
const RESTART_GRACE_MS = 60_000;

const state = {
    restart: null as null | { since: number; done: Promise<void>; resolve: () => void },
    lastStartedAt: Number.NEGATIVE_INFINITY,
    stopped: true,
};

export function markCoreRestartStarted(): void {
    if (state.restart) return;

    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    state.restart = { since: performance.now(), done, resolve };
    state.lastStartedAt = state.restart.since;
    state.stopped = false;
}

export function markCoreRestartFinished(): void {
    state.restart?.resolve();
    state.restart = null;
}

/**
 * The core was stopped on purpose (by ledger or the last panel): cached answers must not
 * make it look alive.
 */
export function markCoreStopped(): void {
    state.stopped = true;
}

export function isCoreStopped(): boolean {
    return state.stopped;
}

export function isCoreRestarting(): boolean {
    return state.restart !== null && performance.now() - state.restart.since < RESTART_GRACE_MS;
}

export function getCoreRestartSince(): null | number {
    return state.restart?.since ?? null;
}

/**
 * Resolves when the current restart (if any) is over.
 */
export async function waitCoreRestart(): Promise<void> {
    await state.restart?.done;
}

/**
 * True if a core restart has started after the given moment (performance.now()).
 */
export function hasCoreRestartedSince(moment: number): boolean {
    return state.lastStartedAt > moment;
}
