import { getSemaphore } from '@henrygd/semaphore';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { fromXrayEmail, getPanelIds } from '@common/multi-panel';
import { getCoreStartedAt, isCoreRestarting, isCoreStopped } from '@common/utils/core-restart';

/** Minimal pause between two background drains. */
const DRAIN_INTERVAL_MS = Math.max(200, Number(process.env.STATS_DRAIN_INTERVAL_MS) || 5_000);
/** Without a successful drain for this long the buffers are reported as unavailable. */
const STALE_AFTER_MS = 30_000;
/** Buffers of a panel that did not poll for this long are dropped. */
const ABANDONED_AFTER_MS = 10 * 60_000;
const WARN_EVERY_MS = 60_000;

type TKind = keyof IDrainResult;

interface ITraffic {
    uplink: number;
    downlink: number;
}

class PanelLedger {
    public readonly users = new Map<string, ITraffic>();
    public readonly inbounds = new Map<string, ITraffic>();
    public readonly outbounds = new Map<string, ITraffic>();
    public lastPolledAt = performance.now();

    public get isEmpty(): boolean {
        return this.users.size === 0 && this.inbounds.size === 0 && this.outbounds.size === 0;
    }

    public clear(): void {
        this.users.clear();
        this.inbounds.clear();
        this.outbounds.clear();
    }
}

interface IDrainResult {
    users: boolean;
    inbounds: boolean;
    outbounds: boolean;
}

function accumulate(target: Map<string, ITraffic>, key: string, uplink: number, downlink: number) {
    if (uplink === 0 && downlink === 0) return;

    const entry = target.get(key);

    if (entry) {
        entry.uplink += uplink;
        entry.downlink += downlink;
    } else {
        target.set(key, { uplink, downlink });
    }
}

/**
 * Splits an integer amount of bytes by weights (largest remainder method), so the parts
 * are integers and always sum up to the original value. Zero weights → equal split.
 */
export function splitByWeights(value: number, weights: number[]): number[] {
    if (weights.length === 0) return [];

    const totalWeight = weights.reduce((acc, w) => acc + w, 0);
    const effective = totalWeight > 0 ? weights : weights.map(() => 1);
    const effectiveTotal = totalWeight > 0 ? totalWeight : weights.length;

    const exact = effective.map((w) => (value * w) / effectiveTotal);
    const parts = exact.map((x) => Math.floor(x));

    let rest = value - parts.reduce((acc, p) => acc + p, 0);

    const order = exact
        .map((x, i) => ({ i, frac: x - Math.floor(x), w: effective[i] }))
        .filter((x) => x.w > 0)
        .sort((a, b) => b.frac - a.frac || a.i - b.i);

    for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length, rest--) {
        parts[order[k].i]++;
    }

    return parts;
}

/**
 * Xray traffic counters are global: whoever reads them with `reset: true` takes the
 * traffic away from everyone else. With several panels attached, the node always
 * drains all counters itself (users + inbounds + outbounds at once) and keeps a
 * separate buffer per panel:
 *
 *  - user traffic goes to the panel that owns the user,
 *  - inbound / outbound traffic (node usage) is split between panels proportionally
 *    to the traffic of their users in the same interval (uplink and downlink
 *    separately). Traffic that can't be attributed (no user traffic in the interval)
 *    is split equally.
 *
 * A panel then reads (and optionally resets) only its own buffer, so every panel
 * accounts only the node traffic its own users have consumed.
 *
 * Counters are drained in the background, one drain at a time: the next one starts
 * max(STATS_DRAIN_INTERVAL_MS, 2 × duration of the last one) after the previous one has
 * finished. Panel requests are answered from the buffers at once, without a gRPC call and
 * without waiting for drains made for other panels (with 20+ panels polling at the same
 * second, a drain per request queued them for longer than the panel's request timeout).
 * The buffers are at most one interval behind the core.
 */
@Injectable()
export class StatsLedgerService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(StatsLedgerService.name);
    private readonly mutex = getSemaphore();
    private readonly ledgers = new Map<number, PanelLedger>();
    private readonly panelIds: number[];
    private readonly lastDrainedAt: Record<TKind, number> = {
        users: Number.NEGATIVE_INFINITY,
        inbounds: Number.NEGATIVE_INFINITY,
        outbounds: Number.NEGATIVE_INFINITY,
    };
    private readonly lastWarnAt = new Map<string, number>();
    private timer: NodeJS.Timeout | null = null;
    private closed = false;

    constructor(@InjectXtls() private readonly xtlsSdk: XtlsApi) {
        this.panelIds = getPanelIds();

        for (const panelId of this.panelIds) {
            this.ledgers.set(panelId, new PanelLedger());
        }
    }

    public onApplicationBootstrap(): void {
        this.logger.log(
            `Traffic counters are drained every ${DRAIN_INTERVAL_MS / 1000} s or more.`,
        );
        this.schedule(DRAIN_INTERVAL_MS);
    }

    public onModuleDestroy(): void {
        this.closed = true;

        if (this.timer) clearTimeout(this.timer);
    }

    /**
     * Moves the current Xray counters into the buffers right now (before the core is
     * stopped or users are removed from it).
     */
    public async drain(): Promise<void> {
        await this.withLock(() => this.drainAll());
    }

    public async takeUsersStats(
        panelId: number,
        reset: boolean,
    ): Promise<Array<{ username: string } & ITraffic> | null> {
        return this.take(panelId, ['users'], (ledger) => {
            const result = [...ledger.users].map(([username, traffic]) => ({
                username,
                uplink: traffic.uplink,
                downlink: traffic.downlink,
            }));

            if (reset) {
                ledger.users.clear();
            }

            return result;
        });
    }

    public async takeInboundsStats(
        panelId: number,
        reset: boolean,
    ): Promise<Array<{ inbound: string } & ITraffic> | null> {
        return this.take(panelId, ['inbounds'], (ledger) => {
            const result = [...ledger.inbounds].map(([inbound, traffic]) => ({
                inbound,
                uplink: traffic.uplink,
                downlink: traffic.downlink,
            }));

            if (reset) {
                ledger.inbounds.clear();
            }

            return result;
        });
    }

    public async takeOutboundsStats(
        panelId: number,
        reset: boolean,
    ): Promise<Array<{ outbound: string } & ITraffic> | null> {
        return this.take(panelId, ['outbounds'], (ledger) => {
            const result = [...ledger.outbounds].map(([outbound, traffic]) => ({
                outbound,
                uplink: traffic.uplink,
                downlink: traffic.downlink,
            }));

            if (reset) {
                ledger.outbounds.clear();
            }

            return result;
        });
    }

    public async takeCombinedStats(
        panelId: number,
        reset: boolean,
    ): Promise<{
        inbounds: Array<{ inbound: string } & ITraffic>;
        outbounds: Array<{ outbound: string } & ITraffic>;
    } | null> {
        return this.take(panelId, ['inbounds', 'outbounds'], (ledger) => {
            const result = {
                inbounds: [...ledger.inbounds].map(([inbound, traffic]) => ({
                    inbound,
                    uplink: traffic.uplink,
                    downlink: traffic.downlink,
                })),
                outbounds: [...ledger.outbounds].map(([outbound, traffic]) => ({
                    outbound,
                    uplink: traffic.uplink,
                    downlink: traffic.downlink,
                })),
            };

            if (reset) {
                ledger.inbounds.clear();
                ledger.outbounds.clear();
            }

            return result;
        });
    }

    public async takeInboundStats(
        panelId: number,
        tag: string,
        reset: boolean,
    ): Promise<({ inbound: string } & ITraffic) | null> {
        return this.take(panelId, ['inbounds'], (ledger) => {
            const traffic = ledger.inbounds.get(tag) ?? { uplink: 0, downlink: 0 };

            if (reset) {
                ledger.inbounds.delete(tag);
            }

            return { inbound: tag, uplink: traffic.uplink, downlink: traffic.downlink };
        });
    }

    public async takeOutboundStats(
        panelId: number,
        tag: string,
        reset: boolean,
    ): Promise<({ outbound: string } & ITraffic) | null> {
        return this.take(panelId, ['outbounds'], (ledger) => {
            const traffic = ledger.outbounds.get(tag) ?? { uplink: 0, downlink: 0 };

            if (reset) {
                ledger.outbounds.delete(tag);
            }

            return { outbound: tag, uplink: traffic.uplink, downlink: traffic.downlink };
        });
    }

    /**
     * Answers from the buffer of the panel, never waits for a drain. During a planned core
     * restart the counters were drained right before the stop, so the buffers are complete
     * and are answered as is. Without a successful drain for STALE_AFTER_MS (or with the
     * core stopped) the buffers are reported as unavailable instead of empty, so the
     * panel does not record "no traffic" for a broken node.
     */
    private take<T>(panelId: number, kinds: TKind[], read: (ledger: PanelLedger) => T): null | T {
        const ledger = this.getLedger(panelId);

        ledger.lastPolledAt = performance.now();

        const stale = kinds.find((kind) => !this.isFresh(kind));

        if (stale) {
            this.warnThrottled(
                `stale-${stale}`,
                `No successful drain of ${stale} counters for more than ${STALE_AFTER_MS / 1000} s, stats requests fail meanwhile.`,
            );
            return null;
        }

        return read(ledger);
    }

    private isFresh(kind: TKind): boolean {
        if (isCoreRestarting()) return true;
        if (isCoreStopped()) return false;

        const since = Math.max(this.lastDrainedAt[kind], getCoreStartedAt());

        return performance.now() - since <= STALE_AFTER_MS;
    }

    private schedule(delay: number): void {
        if (this.closed) return;

        this.timer = setTimeout(() => void this.tick(), delay);
        this.timer.unref();
    }

    private async tick(): Promise<void> {
        let pause = DRAIN_INTERVAL_MS;

        try {
            if (!isCoreRestarting() && !isCoreStopped()) {
                const duration = await this.withLock(async () => {
                    const start = performance.now();
                    await this.drainAll();
                    return performance.now() - start;
                });

                pause = Math.max(DRAIN_INTERVAL_MS, 2 * duration);
            }

            this.dropAbandoned();
        } catch (error) {
            this.warnThrottled('tick', `Background drain failed: ${error}`);
        } finally {
            this.schedule(pause);
        }
    }

    /**
     * A panel that stopped polling (detached, deleted, unreachable) would keep its buffers
     * growing forever.
     */
    private dropAbandoned(): void {
        const now = performance.now();

        for (const [panelId, ledger] of this.ledgers) {
            if (now - ledger.lastPolledAt > ABANDONED_AFTER_MS && !ledger.isEmpty) {
                ledger.clear();
                this.logger.log(
                    `[panel #${panelId}] No stats requests for ${ABANDONED_AFTER_MS / 60_000} min, its traffic buffers were dropped.`,
                );
            }
        }
    }

    private warnThrottled(key: string, message: unknown): void {
        const now = performance.now();

        if (now - (this.lastWarnAt.get(key) ?? Number.NEGATIVE_INFINITY) < WARN_EVERY_MS) return;

        this.lastWarnAt.set(key, now);
        this.logger.warn(message);
    }

    /**
     * Reads (and resets) every Xray counter and distributes the deltas between panels.
     * Users are drained first: their traffic in this interval defines the share of
     * every panel in the node traffic of the same interval.
     */
    private async drainAll(): Promise<IDrainResult> {
        const result: IDrainResult = { users: false, inbounds: false, outbounds: false };

        const upWeights = new Map<number, number>(this.panelIds.map((id) => [id, 0]));
        const downWeights = new Map<number, number>(this.panelIds.map((id) => [id, 0]));

        // Read (and reset) all counters at once: bytes that flow between separate reads
        // would be split by the weights of the wrong interval.
        const [usersResponse, inboundsResponse, outboundsResponse] = await Promise.all([
            this.xtlsSdk.stats.getAllUsersStats(true),
            this.xtlsSdk.stats.getAllInboundsStats(true),
            this.xtlsSdk.stats.getAllOutboundsStats(true),
        ]);

        if (usersResponse.isOk && usersResponse.data) {
            result.users = true;

            for (const user of usersResponse.data.users) {
                const owner = fromXrayEmail(user.username);
                const ledger = this.ledgers.get(owner.panelId);

                if (!ledger) continue;

                accumulate(ledger.users, owner.username, user.uplink, user.downlink);

                upWeights.set(owner.panelId, upWeights.get(owner.panelId)! + user.uplink);
                downWeights.set(owner.panelId, downWeights.get(owner.panelId)! + user.downlink);
            }
        } else if (!isCoreRestarting()) {
            this.warnThrottled('users', usersResponse);
        }

        const up = this.panelIds.map((id) => upWeights.get(id)!);
        const down = this.panelIds.map((id) => downWeights.get(id)!);

        if (inboundsResponse.isOk && inboundsResponse.data) {
            result.inbounds = true;

            for (const item of inboundsResponse.data.inbounds) {
                this.distribute('inbounds', item.inbound, item.uplink, item.downlink, up, down);
            }
        }

        if (outboundsResponse.isOk && outboundsResponse.data) {
            result.outbounds = true;

            for (const item of outboundsResponse.data.outbounds) {
                this.distribute('outbounds', item.outbound, item.uplink, item.downlink, up, down);
            }
        }

        const now = performance.now();

        for (const kind of Object.keys(result) as TKind[]) {
            if (result[kind]) this.lastDrainedAt[kind] = now;
        }

        return result;
    }

    private distribute(
        kind: 'inbounds' | 'outbounds',
        tag: string,
        uplink: number,
        downlink: number,
        upWeights: number[],
        downWeights: number[],
    ): void {
        if (uplink === 0 && downlink === 0) return;

        const upParts = splitByWeights(uplink, upWeights);
        const downParts = splitByWeights(downlink, downWeights);

        this.panelIds.forEach((panelId, index) => {
            accumulate(this.ledgers.get(panelId)![kind], tag, upParts[index], downParts[index]);
        });
    }

    private getLedger(panelId: number): PanelLedger {
        let ledger = this.ledgers.get(panelId);

        if (!ledger) {
            ledger = new PanelLedger();
            this.ledgers.set(panelId, ledger);
        }

        return ledger;
    }

    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.mutex.acquire();

        try {
            return await fn();
        } finally {
            this.mutex.release();
        }
    }
}
