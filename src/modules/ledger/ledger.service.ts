import os from 'node:os';

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { getPanelActivity } from '@common/ledger';

import { InternalService } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { XrayService } from '../xray-core/xray.service';

/** Not more than one restart per this interval. */
const RESTART_MIN_INTERVAL_MS = 10_000;

/** The panel polls the node every few seconds: silence longer than this means it is gone. */
const PANEL_CONNECTED_WITHIN_MS = 60_000;

@Injectable()
export class LedgerService {
    private lastRestartAt = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly xrayService: XrayService,
        private readonly internalService: InternalService,
        private readonly queryBus: QueryBus,
    ) {}

    public async getStatus() {
        const core = this.xrayService.getCoreState();
        const activity = getPanelActivity();
        const iface = await this.queryBus.execute(new GetInterfaceStatsQuery());
        const load = os.loadavg();

        return {
            nodeVersion: __RWNODE_VERSION__ ?? '0.0.0',
            xray: {
                online: core.online,
                version: core.version,
                uptimeSec: await this.xrayService.getCoreUptimeSec(),
                restarting: core.restarting,
            },
            panel: {
                connected:
                    activity.lastRequestAt !== null &&
                    Date.now() - activity.lastRequestAt.getTime() <= PANEL_CONNECTED_WITHIN_MS,
                lastStartAt: activity.lastStartAt?.toISOString() ?? null,
                lastRequestAt: activity.lastRequestAt?.toISOString() ?? null,
                users: this.internalService.getUsersCount(),
            },
            system: {
                cpus: os.cpus().length,
                load1: load[0],
                load5: load[1],
                load15: load[2],
                memTotal: os.totalmem(),
                memUsed: os.totalmem() - os.freemem(),
                uptimeSec: Math.round(os.uptime()),
                iface: iface?.interface ?? null,
                rxBps: iface?.rxBytesPerSec ?? null,
                txBps: iface?.txBytesPerSec ?? null,
            },
        };
    }

    public async restartCore(reason: string | undefined) {
        const now = performance.now();

        if (now - this.lastRestartAt < RESTART_MIN_INTERVAL_MS) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: `Not more than one restart per ${RESTART_MIN_INTERVAL_MS / 1000} s`,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        this.lastRestartAt = now;

        return this.xrayService.ledgerRestartCore(reason ?? '');
    }
}
