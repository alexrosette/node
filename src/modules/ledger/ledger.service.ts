import os from 'node:os';

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { getPanelActivity, getPanels } from '@common/multi-panel';
import { isCoreRestarting } from '@common/utils/core-restart';

import { InternalService } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { ILedgerCoreResult, XrayService } from '../xray-core/xray.service';

/** Not more than one restart / config change per this interval. */
const RESTART_MIN_INTERVAL_MS = 10_000;

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
        const base = this.internalService.getLedgerBase();
        const activePanels = new Set(this.internalService.getActivePanelIds());
        const iface = await this.queryBus.execute(new GetInterfaceStatsQuery());
        const load = os.loadavg();

        return {
            nodeVersion: __RWNODE_VERSION__ ?? '0.0.0',
            xray: {
                online: core.online,
                version: core.version,
                uptimeSec: await this.xrayService.getCoreUptimeSec(),
                restarting: isCoreRestarting(),
                stoppedByLedger: core.stoppedByLedger,
            },
            base: base
                ? { source: 'ledger', hash: base.hash, updatedAt: base.updatedAt.toISOString() }
                : {
                      source: 'panel',
                      hash: this.internalService.getTemplateHash(),
                      updatedAt: null,
                  },
            panels: getPanels().map((panel) => {
                const activity = getPanelActivity(panel.id);

                return {
                    id: panel.id,
                    label: panel.label,
                    connected: activePanels.has(panel.id),
                    lastStartAt: activity.lastStartAt?.toISOString() ?? null,
                    lastRequestAt: activity.lastRequestAt?.toISOString() ?? null,
                    users: this.internalService.getPanelUsersCount(panel.id),
                };
            }),
            system: {
                cpus: os.cpus().length,
                load1: load[0],
                memTotal: os.totalmem(),
                memUsed: os.totalmem() - os.freemem(),
                uptimeSec: Math.round(os.uptime()),
                iface: iface?.interface ?? null,
                rxBps: iface?.rxBytesPerSec ?? null,
                txBps: iface?.txBytesPerSec ?? null,
            },
        };
    }

    public getConfig() {
        const base = this.internalService.getLedgerBase();

        if (!base) {
            throw new HttpException(
                { statusCode: HttpStatus.NOT_FOUND, message: 'No base config from ledger yet' },
                HttpStatus.NOT_FOUND,
            );
        }

        return { config: base.config, hash: base.hash, updatedAt: base.updatedAt.toISOString() };
    }

    public async putConfig(config: Record<string, unknown>, baseHash: string | undefined) {
        const releaseSlot = this.takeRestartSlot();

        const result = await this.xrayService.ledgerApplyBase(config, baseHash);

        // A rejected config did not touch the core: it does not use up the slot.
        if (result.kind !== 'applied') {
            releaseSlot();
        }

        if (result.kind === 'conflict') {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: 'baseHash does not match the current base config',
                    currentHash: result.currentHash,
                },
                HttpStatus.CONFLICT,
            );
        }

        if (result.kind === 'invalid') {
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    message: 'Xray Core rejected the config',
                    output: result.output,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        return { hash: result.hash, ...this.toCoreResponse(result.result) };
    }

    public async restartCore(reason: string | undefined) {
        this.takeRestartSlot();

        return this.toCoreResponse(await this.xrayService.ledgerRestartCore(reason ?? ''));
    }

    public async startCore() {
        return this.toCoreResponse(await this.xrayService.ledgerStartCore());
    }

    public async stopCore() {
        return this.xrayService.ledgerStopCore();
    }

    private toCoreResponse(result: ILedgerCoreResult) {
        return {
            isStarted: result.isStarted,
            error: result.error,
            tookMs: result.tookMs,
            version: result.version,
        };
    }

    /**
     * Returns a function that gives the slot back.
     */
    private takeRestartSlot(): () => void {
        const now = performance.now();
        const previous = this.lastRestartAt;

        if (now - this.lastRestartAt < RESTART_MIN_INTERVAL_MS) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: `Not more than one restart / config change per ${RESTART_MIN_INTERVAL_MS / 1000} s`,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        this.lastRestartAt = now;

        return () => {
            this.lastRestartAt = previous;
        };
    }
}
