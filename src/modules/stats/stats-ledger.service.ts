import { getSemaphore } from '@henrygd/semaphore';

import { Injectable, Logger } from '@nestjs/common';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { fromXrayEmail, getPanelIds } from '@common/multi-panel';

interface ITraffic {
    uplink: number;
    downlink: number;
}

class PanelLedger {
    public readonly users = new Map<string, ITraffic>();
    public readonly inbounds = new Map<string, ITraffic>();
    public readonly outbounds = new Map<string, ITraffic>();
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
 */
@Injectable()
export class StatsLedgerService {
    private readonly logger = new Logger(StatsLedgerService.name);
    private readonly mutex = getSemaphore();
    private readonly ledgers = new Map<number, PanelLedger>();
    private readonly panelIds: number[];

    constructor(@InjectXtls() private readonly xtlsSdk: XtlsApi) {
        this.panelIds = getPanelIds();

        for (const panelId of this.panelIds) {
            this.ledgers.set(panelId, new PanelLedger());
        }
    }

    public async takeUsersStats(
        panelId: number,
        reset: boolean,
    ): Promise<Array<{ username: string } & ITraffic> | null> {
        return this.withLock(async () => {
            if (!(await this.drainAll()).users) return null;

            const ledger = this.getLedger(panelId);
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
        return this.withLock(async () => {
            if (!(await this.drainAll()).inbounds) return null;

            const ledger = this.getLedger(panelId);
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
        return this.withLock(async () => {
            if (!(await this.drainAll()).outbounds) return null;

            const ledger = this.getLedger(panelId);
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
        return this.withLock(async () => {
            const drained = await this.drainAll();

            if (!drained.inbounds || !drained.outbounds) return null;

            const ledger = this.getLedger(panelId);

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
        return this.withLock(async () => {
            if (!(await this.drainAll()).inbounds) return null;

            const ledger = this.getLedger(panelId);
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
        return this.withLock(async () => {
            if (!(await this.drainAll()).outbounds) return null;

            const ledger = this.getLedger(panelId);
            const traffic = ledger.outbounds.get(tag) ?? { uplink: 0, downlink: 0 };

            if (reset) {
                ledger.outbounds.delete(tag);
            }

            return { outbound: tag, uplink: traffic.uplink, downlink: traffic.downlink };
        });
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

        const usersResponse = await this.xtlsSdk.stats.getAllUsersStats(true);

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
        } else {
            this.logger.warn(usersResponse);
        }

        const up = this.panelIds.map((id) => upWeights.get(id)!);
        const down = this.panelIds.map((id) => downWeights.get(id)!);

        const inboundsResponse = await this.xtlsSdk.stats.getAllInboundsStats(true);

        if (inboundsResponse.isOk && inboundsResponse.data) {
            result.inbounds = true;

            for (const item of inboundsResponse.data.inbounds) {
                this.distribute('inbounds', item.inbound, item.uplink, item.downlink, up, down);
            }
        }

        const outboundsResponse = await this.xtlsSdk.stats.getAllOutboundsStats(true);

        if (outboundsResponse.isOk && outboundsResponse.data) {
            result.outbounds = true;

            for (const item of outboundsResponse.data.outbounds) {
                this.distribute('outbounds', item.outbound, item.uplink, item.downlink, up, down);
            }
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
