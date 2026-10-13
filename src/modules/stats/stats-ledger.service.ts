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
 * Xray traffic counters are global: whoever reads them with `reset: true` takes the
 * traffic away from everyone else. With several panels attached, the node always
 * drains the counters itself and keeps a separate buffer per panel:
 *
 *  - user traffic goes to the panel that owns the user,
 *  - inbound / outbound traffic goes to every panel.
 *
 * A panel then reads (and optionally resets) only its own buffer.
 */
@Injectable()
export class StatsLedgerService {
    private readonly logger = new Logger(StatsLedgerService.name);
    private readonly mutex = getSemaphore();
    private readonly ledgers = new Map<number, PanelLedger>();

    constructor(@InjectXtls() private readonly xtlsSdk: XtlsApi) {
        for (const panelId of getPanelIds()) {
            this.ledgers.set(panelId, new PanelLedger());
        }
    }

    public async takeUsersStats(
        panelId: number,
        reset: boolean,
    ): Promise<Array<{ username: string } & ITraffic> | null> {
        return this.withLock(async () => {
            const response = await this.xtlsSdk.stats.getAllUsersStats(true);

            if (!response.isOk || !response.data) {
                this.logger.warn(response);
                return null;
            }

            for (const user of response.data.users) {
                const owner = fromXrayEmail(user.username);
                const ledger = this.ledgers.get(owner.panelId);

                if (!ledger) continue;

                accumulate(ledger.users, owner.username, user.uplink, user.downlink);
            }

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
            if (!(await this.drainInbounds())) return null;

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
            if (!(await this.drainOutbounds())) return null;

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

    public async takeInboundStats(
        panelId: number,
        tag: string,
        reset: boolean,
    ): Promise<({ inbound: string } & ITraffic) | null> {
        return this.withLock(async () => {
            if (!(await this.drainInbounds())) return null;

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
            if (!(await this.drainOutbounds())) return null;

            const ledger = this.getLedger(panelId);
            const traffic = ledger.outbounds.get(tag) ?? { uplink: 0, downlink: 0 };

            if (reset) {
                ledger.outbounds.delete(tag);
            }

            return { outbound: tag, uplink: traffic.uplink, downlink: traffic.downlink };
        });
    }

    private async drainInbounds(): Promise<boolean> {
        const response = await this.xtlsSdk.stats.getAllInboundsStats(true);

        if (!response.isOk || !response.data) {
            return false;
        }

        for (const ledger of this.ledgers.values()) {
            for (const item of response.data.inbounds) {
                accumulate(ledger.inbounds, item.inbound, item.uplink, item.downlink);
            }
        }

        return true;
    }

    private async drainOutbounds(): Promise<boolean> {
        const response = await this.xtlsSdk.stats.getAllOutboundsStats(true);

        if (!response.isOk || !response.data) {
            return false;
        }

        for (const ledger of this.ledgers.values()) {
            for (const item of response.data.outbounds) {
                accumulate(ledger.outbounds, item.outbound, item.uplink, item.downlink);
            }
        }

        return true;
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
