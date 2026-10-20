import ems from 'enhanced-ms';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pMap from 'p-map';
import pRetry, { AbortError } from 'p-retry';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { TypedConfigService } from '@common/config/app-config';
import { isLedgerMode, markPanelStart, PRIMARY_PANEL_ID } from '@common/multi-panel';
import { ok, TResult } from '@common/types';
import { withCoreLock } from '@common/utils/core-lock';
import {
    hasCoreRestartedSince,
    markCoreRestartFinished,
    markCoreRestartStarted,
    markCoreStopped,
} from '@common/utils/core-restart';
import { generateApiConfig } from '@common/utils/generate-api-config';
import { getSystemInfo, getSystemStats } from '@common/utils/get-system-stats';
import { readLedgerBase, saveLedgerBase } from '@common/utils/ledger-base-store';
import { addXrayClientViaApi } from '@common/utils/xray-clients';
import { StartXrayCommand } from '@libs/contracts/commands';
import { KNOWN_ERRORS } from '@libs/contracts/constants';
import { TNodeMetadata } from '@libs/contracts/models';

import { IntegrationsService } from '@integration-modules/integrations.service';

import { ResetPluginsCommand } from '../_plugin/commands/reset-plugins/reset-plugins.command';
import { RunPostStartCommand } from '../_plugin/commands/run-post-start/run-post-start.command';
import { RunPreStartCommand } from '../_plugin/commands/run-pre-start/run-pre-start.command';
import { GetTorrentBlockerStateQuery } from '../_plugin/queries/get-torrent-blocker-state';
import { InternalService, TPanelClients, TXrayClient } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { DrainStatsCommand } from '../stats/commands/drain-stats/drain-stats.command';
import { CoreLoaderService } from './core-loader.service';
import { GeodataService } from './geodata.service';
import {
    GetNodeHealthCheckResponseModel,
    StartXrayResponseModel,
    StopXrayResponseModel,
} from './models';
import { XrayProcessService } from './xray-process.service';

const XRAY_LOG_FILE = '/var/log/xray/current' as const;
const execFileAsync = promisify(execFile);

const HOT_SYNC_MAX_OPERATIONS = 50_000;
const HOT_SYNC_CONCURRENCY = 32;

function diffPanelClients(
    previous: TPanelClients,
    next: TPanelClients,
): {
    removals: Array<{ tag: string; email: string }>;
    additions: Array<{ tag: string; client: TXrayClient }>;
} {
    const removals: Array<{ tag: string; email: string }> = [];
    const additions: Array<{ tag: string; client: TXrayClient }> = [];
    const empty = new Map<string, TXrayClient>();

    const tags = new Set([...previous.keys(), ...next.keys()]);

    for (const tag of tags) {
        const prevClients = previous.get(tag) ?? empty;
        const nextClients = next.get(tag) ?? empty;

        for (const [email, client] of prevClients) {
            const nextClient = nextClients.get(email);

            if (!nextClient || JSON.stringify(nextClient) !== JSON.stringify(client)) {
                removals.push({ tag, email });
            }
        }

        for (const [email, client] of nextClients) {
            const prevClient = prevClients.get(email);

            if (!prevClient || JSON.stringify(prevClient) !== JSON.stringify(client)) {
                additions.push({ tag, client });
            }
        }
    }

    return { removals, additions };
}

export interface ILedgerCoreResult {
    isStarted: boolean;
    error: null | string;
    tookMs: number;
    version: null | string;
}

class XrayProcessDownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'XrayProcessDownError';
    }
}

@Injectable()
export class XrayService implements OnApplicationBootstrap {
    private readonly logger = new Logger(XrayService.name);
    private readonly disableHashedSetCheck: boolean;
    private readonly internal: {
        socketPath: string;
        token: string;
        xtlsApiSocketPath: string;
    };

    private readonly xrayPath: string;

    private xrayVersion: null | string = null;
    private isXrayOnline: boolean = false;
    /** Ledger stopped the core: panels can't start it again, only ledger can. */
    private isStoppedByLedger: boolean = false;
    private nodeVersion: string = '0.0.0';
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        private readonly xrayProcess: XrayProcessService,
        private readonly geodataService: GeodataService,
        private readonly coreLoaderService: CoreLoaderService,
        private readonly integrations: IntegrationsService,
        private readonly internalService: InternalService,
        private readonly configService: TypedConfigService,
        private readonly queryBus: QueryBus,
        private readonly commandBus: CommandBus,
    ) {
        this.internal = {
            socketPath: this.configService.getOrThrow('INTERNAL_SOCKET_PATH'),
            token: this.configService.getOrThrow('INTERNAL_REST_TOKEN'),
            xtlsApiSocketPath: this.configService.getOrThrow('XTLS_API_SOCKET_PATH'),
        };

        this.xrayPath = '/usr/local/bin/rw-core';
        this.xrayVersion = null;

        this.disableHashedSetCheck = this.configService.getOrThrow('DISABLE_HASHED_SET_CHECK');
    }

    async onApplicationBootstrap() {
        try {
            await this.refreshXrayVersion();
            this.nodeVersion = __RWNODE_VERSION__ ?? '0.0.0';

            if (!this.xrayProcess.isControlAvailable()) {
                this.logger.error('s6 xray control socket not found, exiting...');
                process.exit(1);
            }
        } catch (error: unknown) {
            this.logger.error(`Error in Application Bootstrap: ${error}`);
        }

        this.isXrayOnline = false;
    }

    public async startXray(
        body: StartXrayCommand.Request,
        ip: string,
        panelId: number = PRIMARY_PANEL_ID,
    ): Promise<TResult<StartXrayResponseModel>> {
        const requestedAt = performance.now();

        return withCoreLock(() => this.startXrayUnsafe(body, ip, panelId, requestedAt));
    }

    private async startXrayUnsafe(
        body: StartXrayCommand.Request,
        ip: string,
        panelId: number,
        requestedAt: number,
    ): Promise<TResult<StartXrayResponseModel>> {
        const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
        const tm = performance.now();
        const system = {
            info: getSystemInfo(),
            stats: getSystemStats(),
            interface: interfaceStats,
        };

        const respond = (isStarted: boolean, version: null | string, error: null | string) =>
            ok(
                new StartXrayResponseModel(
                    isStarted,
                    version,
                    error,
                    {
                        version: this.nodeVersion,
                    },
                    system,
                ),
            );

        try {
            const integrations = await this.integrations.sync(
                body.internals.integrations,
                body.internals.metadata,
            );

            if (integrations.error) {
                this.logger.error(`Failed to sync integrations: ${integrations.error}`);
                return respond(false, null, integrations.error);
            }

            let { forceRestart } = body.internals;
            const isLedgerBase = this.internalService.isLedgerBase();

            markPanelStart(panelId);

            if (isLedgerBase && forceRestart) {
                this.logger.warn(
                    `[panel #${panelId}] Force restart ignored: Xray Core is managed by ledger.`,
                );
                forceRestart = false;
            }

            if (isLedgerBase && this.isStoppedByLedger) {
                this.logger.warn(
                    `[panel #${panelId}] Xray Core is stopped by ledger, start request ignored.`,
                );

                return respond(false, null, 'Xray Core is stopped by ledger');
            }

            // The core was restarted while this request waited for the lock (e.g. the
            // managing panel restarted it and the others re-sent start). One restart is
            // enough: the running config already includes every panel's users, so only the
            // usual hash check / hot sync is left.
            if (forceRestart && this.isXrayOnline && hasCoreRestartedSince(requestedAt)) {
                this.logger.log(
                    `[panel #${panelId}] Force restart skipped: core was restarted while the request was waiting.`,
                );
                forceRestart = false;
            }

            // With the base from ledger panels never restart the core on their own: only
            // users are synced (a restart happens only if hot sync is impossible).
            const useHashCheck = !this.disableHashedSetCheck || isLedgerBase;

            if (this.isXrayOnline && useHashCheck && !forceRestart) {
                const { isOk } = await this.xtlsSdk.stats.getSysStats();

                if (isOk) {
                    if (!this.internalService.isNeedRestartCore(panelId, body.internals.hashes)) {
                        return respond(true, this.xrayVersion, null);
                    }

                    if (await this.tryHotSyncPanel(panelId, body)) {
                        await this.commandBus.execute(
                            new RunPostStartCommand(body.internals.metadata),
                        );

                        return respond(true, this.xrayVersion, null);
                    }
                } else {
                    this.isXrayOnline = false;

                    this.logger.warn(`Xray Core health check failed, restarting...`);
                }
            }

            if (forceRestart) {
                this.logger.warn(`[panel #${panelId}] Force restart requested`);
            }

            const panelConfig = this.internalService.namespaceConfigUsers(panelId, body.xrayConfig);

            await this.internalService.ingestPanelConfig(
                panelId,
                body.internals.hashes,
                panelConfig,
            );
            this.internalService.setTemplate(
                panelId,
                panelConfig,
                body.internals.hashes.emptyConfig,
            );

            await this.rebuildFullConfig();

            const { isStarted, error: startError } = await this.bootCore(body.internals.metadata);

            return respond(isStarted, this.xrayVersion, startError);
        } catch (error) {
            let errorMessage = null;
            if (error instanceof Error) {
                errorMessage = error.message;
            }

            this.logger.error(`Failed to start Xray: ${errorMessage}`);

            return respond(false, null, errorMessage);
        } finally {
            this.logger.log(
                `[panel #${panelId}] Attempt to start XTLS took: ${ems(performance.now() - tm, {
                    extends: 'short',
                    includeMs: true,
                })} (IP: ${ip})`,
            );
        }
    }

    /**
     * (Re)starts Xray Core with the config built by rebuildFullConfig(). While it lasts,
     * panels keep seeing the node online (cached core stats).
     * Must be called under the core lock.
     */
    private async bootCore(
        metadata: TNodeMetadata | undefined,
    ): Promise<{ isStarted: boolean; error: null | string }> {
        const config = await this.internalService.getXrayConfig();

        await this.coreLoaderService.prepare(config.geodata);
        await this.geodataService.prepare(config.geodata);

        markCoreRestartStarted();

        let isStarted: boolean;
        let startError: null | string;

        try {
            const xrayProcess = await this.restartXrayProcess();

            if (xrayProcess.error) {
                this.logger.error(`Failed to (re)start Xray process via s6: ${xrayProcess.error}`);
                this.isXrayOnline = false;

                return { isStarted: false, error: xrayProcess.error };
            }

            ({ isStarted, error: startError } = await this.getXrayInternalStatus());
        } finally {
            markCoreRestartFinished();
        }

        if (!isStarted) {
            this.isXrayOnline = false;

            this.logger.error(`Xray Core v${this.xrayVersion} failed to start.`, {
                timestamp: new Date().toISOString(),
                ...KNOWN_ERRORS.XRAY_FAILED_TO_START,
            });

            const tail = await this.dumpTailBlock(XRAY_LOG_FILE, 5);
            const logReason = tail.at(-1)?.trim().slice(0, 500);

            return { isStarted, error: logReason ? `${startError} · ${logReason}` : startError };
        }

        this.isXrayOnline = true;

        await this.refreshXrayVersion();

        this.logger.log(`✔ XRay Core v${this.xrayVersion} is up and running.`);

        await this.commandBus.execute(new RunPostStartCommand(metadata));

        return { isStarted: true, error: null };
    }

    /**
     * Applies the users of a single panel to the running core through the Xray API,
     * without restarting it (so users of other panels keep their connections).
     *
     * Returns false if a restart is required instead.
     */
    private async tryHotSyncPanel(
        panelId: number,
        body: StartXrayCommand.Request,
    ): Promise<boolean> {
        const tm = performance.now();
        const { hashes } = body.internals;

        if (!this.internalService.hasTemplate()) {
            return false;
        }

        if (
            !this.internalService.isLedgerBase() &&
            this.internalService.getTemplateHash() !== hashes.emptyConfig
        ) {
            this.logger.warn(
                `[panel #${panelId}] Base config differs from the running one, full restart is required.`,
            );
            return false;
        }

        const previous = this.internalService.getPanelClients(panelId);

        const panelConfig = this.internalService.namespaceConfigUsers(panelId, body.xrayConfig);
        await this.internalService.ingestPanelConfig(panelId, hashes, panelConfig);

        const next = this.internalService.getPanelClients(panelId);

        const { removals, additions } = diffPanelClients(previous, next);
        const totalOps = removals.length + additions.length;

        if (totalOps > HOT_SYNC_MAX_OPERATIONS) {
            this.logger.warn(
                `[panel #${panelId}] ${totalOps} user changes, more than hot sync limit (${HOT_SYNC_MAX_OPERATIONS}). Restarting core instead.`,
            );
            return false;
        }

        for (const { tag } of additions) {
            if (!this.internalService.getTemplateInbound(tag)) {
                this.logger.warn(
                    `[panel #${panelId}] Inbound "${tag}" is missing in the running config. Restarting core instead.`,
                );
                return false;
            }
        }

        this.logger.log(
            `[panel #${panelId}] Hot sync: removing ${removals.length}, adding ${additions.length} user entries...`,
        );

        await pMap(
            removals,
            async ({ tag, email }) => {
                await this.xtlsSdk.handler.removeUser(tag, email);
            },
            { concurrency: HOT_SYNC_CONCURRENCY },
        );

        const failures: string[] = [];

        await pMap(
            additions,
            async ({ tag, client }) => {
                const res = await addXrayClientViaApi(
                    this.xtlsSdk,
                    tag,
                    this.internalService.getTemplateInbound(tag),
                    client,
                );

                if (!res.isOk) {
                    failures.push(`${tag}/${String(client.email)}: ${res.message}`);
                }
            },
            { concurrency: HOT_SYNC_CONCURRENCY },
        );

        if (failures.length > 0) {
            this.logger.error(
                `[panel #${panelId}] Hot sync failed for ${failures.length} user entries (first: ${failures[0]}). Restarting core instead.`,
            );
            return false;
        }

        await this.rebuildFullConfig();

        this.logger.log(
            `[panel #${panelId}] ✔ Users synced without core restart in ${ems(
                performance.now() - tm,
                {
                    extends: 'short',
                    includeMs: true,
                },
            )}.`,
        );

        return true;
    }

    /**
     * Rebuilds the config served to Xray Core from the base config and users of all panels.
     */
    private async rebuildFullConfig(): Promise<Record<string, unknown>> {
        const decorate = await this.getConfigDecorator();

        const fullConfig = decorate(this.internalService.buildMergedConfig());

        this.internalService.setXrayConfig(fullConfig, decorate);

        return fullConfig;
    }

    private async getConfigDecorator(): Promise<
        (merged: Record<string, unknown>) => Record<string, unknown>
    > {
        const tblockerState = await this.queryBus.execute(new GetTorrentBlockerStateQuery());

        return (merged: Record<string, unknown>) =>
            generateApiConfig({
                config: merged,
                torrentBlockerState: tblockerState,
                internal: this.internal,
            });
    }

    /**
     * Stop request from a panel. If other panels still use this node, only the users of the
     * requesting panel are detached and the core keeps running.
     */
    public async stopXrayForPanel(panelId: number): Promise<TResult<StopXrayResponseModel>> {
        return withCoreLock(async () => {
            const otherPanels = this.internalService
                .getActivePanelIds()
                .filter((id) => id !== panelId);

            // With the base from ledger only ledger stops the core, even for the last panel.
            if (this.internalService.isLedgerBase() && !this.isXrayOnline) {
                this.internalService.removePanel(panelId);
                return ok(new StopXrayResponseModel(true));
            }

            if (
                !this.isXrayOnline ||
                (otherPanels.length === 0 && !this.internalService.isLedgerBase())
            ) {
                return this.stopXrayUnsafe({
                    withOnlineCheck: false,
                    withPluginCleanup: true,
                });
            }

            try {
                const clients = this.internalService.getPanelClients(panelId);
                const removals = diffPanelClients(clients, new Map()).removals;

                await pMap(
                    removals,
                    async ({ tag, email }) => {
                        await this.xtlsSdk.handler.removeUser(tag, email);
                    },
                    { concurrency: HOT_SYNC_CONCURRENCY },
                );

                this.internalService.removePanel(panelId);
                await this.rebuildFullConfig();

                this.logger.log(
                    `[panel #${panelId}] Detached from node (${removals.length} user entries removed). Xray Core keeps running for ${otherPanels.length > 0 ? `panel(s): ${otherPanels.map((id) => `#${id}`).join(', ')}` : 'ledger'}.`,
                );

                return ok(new StopXrayResponseModel(true));
            } catch (error) {
                this.logger.error(`[panel #${panelId}] Failed to detach panel: ${error}`);
                return ok(new StopXrayResponseModel(false));
            }
        });
    }

    public async stopXray(args: {
        withPluginCleanup?: boolean;
        withOnlineCheck?: boolean;
    }): Promise<TResult<StopXrayResponseModel>> {
        return withCoreLock(() => this.stopXrayUnsafe(args));
    }

    private async stopXrayUnsafe(args: {
        withPluginCleanup?: boolean;
        withOnlineCheck?: boolean;
    }): Promise<TResult<StopXrayResponseModel>> {
        const { withPluginCleanup = false, withOnlineCheck = false } = args;
        try {
            if (withPluginCleanup) {
                await this.commandBus.execute(new ResetPluginsCommand());
            }

            if (withOnlineCheck && !this.isXrayOnline) {
                return ok(new StopXrayResponseModel(true));
            }

            await this.drainStats();
            markCoreStopped();
            await this.killAllXrayProcesses();
            await this.integrations.stop();

            this.isXrayOnline = false;
            this.internalService.cleanup();

            return ok(new StopXrayResponseModel(true));
        } catch (error) {
            this.logger.error(`Failed to stop Xray Process: ${error}`);
            return ok(new StopXrayResponseModel(false));
        }
    }

    // ─── Ledger control (/node/ledger/*) ────────────────────────────────────────────

    public getCoreState(): { online: boolean; version: null | string; stoppedByLedger: boolean } {
        return {
            online: this.isXrayOnline,
            version: this.xrayVersion,
            stoppedByLedger: this.isStoppedByLedger,
        };
    }

    public async getCoreUptimeSec(): Promise<null | number> {
        if (!this.isXrayOnline) return null;

        const { isOk, data } = await this.xtlsSdk.stats.getSysStats();

        return isOk && data ? data.uptime : null;
    }

    /**
     * Restart with the current base + users of every panel, with plugin hooks.
     */
    public async ledgerRestartCore(reason: string): Promise<ILedgerCoreResult> {
        return withCoreLock(async () => {
            this.logger.log(`[ledger] Restarting Xray Core (${reason || 'no reason given'})...`);

            return this.ledgerBoot();
        });
    }

    public async ledgerStartCore(): Promise<ILedgerCoreResult> {
        return withCoreLock(async () => {
            if (this.isXrayOnline) {
                return { isStarted: true, error: null, tookMs: 0, version: this.xrayVersion };
            }

            this.logger.log('[ledger] Starting Xray Core...');

            return this.ledgerBoot();
        });
    }

    public async ledgerStopCore(): Promise<{ isStopped: boolean }> {
        return withCoreLock(async () => {
            this.logger.log('[ledger] Stopping Xray Core for all panels...');

            const result = await this.stopXrayUnsafe({ withPluginCleanup: true });
            const isStopped = result.isOk && result.response.isStopped;

            if (isStopped) {
                this.isStoppedByLedger = true;
            }

            return { isStopped };
        });
    }

    /**
     * New base config from ledger: check it with `xray -test`, save it, apply it (restart).
     */
    public async ledgerApplyBase(
        config: Record<string, unknown>,
        baseHash: string | undefined,
    ): Promise<
        | { kind: 'applied'; hash: string; result: ILedgerCoreResult }
        | { kind: 'conflict'; currentHash: null | string }
        | { kind: 'invalid'; output: string }
    > {
        return withCoreLock(async () => {
            const currentHash = this.internalService.getTemplateHash();

            if (baseHash !== undefined && baseHash !== currentHash) {
                return { kind: 'conflict', currentHash } as const;
            }

            const decorate = await this.getConfigDecorator();
            const candidate = decorate(this.internalService.buildMergedConfig(config));

            await this.coreLoaderService.prepare(candidate.geodata);
            await this.geodataService.prepare(candidate.geodata);

            const test = await this.testConfig(candidate);

            if (!test.isOk) {
                this.logger.error(`[ledger] Base config rejected by Xray Core: ${test.output}`);
                return { kind: 'invalid', output: test.output } as const;
            }

            const updatedAt = new Date();

            await saveLedgerBase({ config, updatedAt: updatedAt.toISOString() });

            const hash = this.internalService.setLedgerBase(config, updatedAt);

            this.logger.log(`[ledger] Base config ${hash.slice(0, 12)} saved, applying...`);

            return { kind: 'applied', hash, result: await this.ledgerBoot() } as const;
        });
    }

    /**
     * Container start in ledger mode: the core is started with the saved base right away,
     * users come with the start requests of the panels.
     */
    public async startFromSavedLedgerBase(): Promise<void> {
        if (!isLedgerMode()) return;

        let saved: Awaited<ReturnType<typeof readLedgerBase>>;

        try {
            saved = await readLedgerBase();
        } catch (error) {
            this.logger.error(`[ledger] Saved base config can't be read: ${error}`);
            return;
        }

        if (!saved) {
            this.logger.log('[ledger] No saved base config yet, panels manage the core.');
            return;
        }

        await withCoreLock(async () => {
            const hash = this.internalService.setLedgerBase(
                saved.config,
                new Date(saved.updatedAt),
            );

            this.logger.log(
                `[ledger] Starting Xray Core with the saved base ${hash.slice(0, 12)}...`,
            );

            const result = await this.ledgerBoot();

            if (!result.isStarted) {
                this.logger.error(`[ledger] Xray Core failed to start: ${result.error}`);
            }
        });
    }

    /** Under the core lock. */
    private async ledgerBoot(): Promise<ILedgerCoreResult> {
        const tm = performance.now();

        if (!this.internalService.hasTemplate()) {
            return {
                isStarted: false,
                error: 'No base config yet',
                tookMs: 0,
                version: this.xrayVersion,
            };
        }

        try {
            await this.rebuildFullConfig();

            this.isStoppedByLedger = false;

            const { isStarted, error } = await this.bootCore(undefined);

            return {
                isStarted,
                error,
                tookMs: Math.round(performance.now() - tm),
                version: this.xrayVersion,
            };
        } catch (error) {
            this.isXrayOnline = false;

            return {
                isStarted: false,
                error: error instanceof Error ? error.message : String(error),
                tookMs: Math.round(performance.now() - tm),
                version: this.xrayVersion,
            };
        }
    }

    private async testConfig(config: Record<string, unknown>): Promise<{
        isOk: boolean;
        output: string;
    }> {
        const dir = await mkdtemp(join(tmpdir(), 'rw-ledger-'));
        const file = join(dir, 'config.json');

        try {
            await writeFile(file, JSON.stringify(config), { mode: 0o600 });

            await execFileAsync(
                this.xrayPath,
                ['run', '-test', '-config', file, '-format', 'json'],
                {
                    timeout: 30_000,
                    maxBuffer: 4 * 1024 * 1024,
                },
            );

            return { isOk: true, output: '' };
        } catch (error) {
            const e = error as { stdout?: string; stderr?: string; message?: string };
            const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'unknown';

            return { isOk: false, output: output.slice(-4000) };
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    public async getNodeHealthCheck(): Promise<TResult<GetNodeHealthCheckResponseModel>> {
        try {
            return ok(
                new GetNodeHealthCheckResponseModel(
                    true,
                    this.isXrayOnline,
                    this.xrayVersion,
                    this.nodeVersion,
                ),
            );
        } catch (error) {
            this.logger.error(`Failed to get node health check: ${error}`);

            return ok(new GetNodeHealthCheckResponseModel(false, false, null, this.nodeVersion));
        }
    }

    public async killAllXrayProcesses(): Promise<void> {
        try {
            await this.xrayProcess.stop();

            this.logger.log('s6: Xray process stopped.');
        } catch (error) {
            this.logger.log(`s6: Failed to stop Xray process. Error: ${error}`);
        }
    }

    private async refreshXrayVersion(): Promise<void> {
        const version = await this.xrayProcess.getCoreVersion();

        if (version) {
            this.xrayVersion = version;
        }
    }

    public getXrayInfo(): {
        version: string | null;
        path: string;
    } {
        return {
            version: this.xrayVersion,
            path: this.xrayPath,
        };
    }

    private async getXrayInternalStatus(): Promise<{
        isStarted: boolean;
        error: string | null;
    }> {
        const tm = performance.now();

        const startedPid = (await this.xrayProcess.getStatus()).pid;

        try {
            await pRetry(
                async () => {
                    const { isOk, message } = await this.xtlsSdk.stats.getSysStats();
                    if (isOk) {
                        return;
                    }

                    const status = await this.xrayProcess.getStatus();

                    if (!status.up || (startedPid !== null && status.pid !== startedPid)) {
                        throw new AbortError(
                            new XrayProcessDownError(
                                `Xray Core process is not running anymore (s6: ${await this.xrayProcess.getStatusLine()})`,
                            ),
                        );
                    }

                    throw new Error(message);
                },
                {
                    retries: 30,
                    minTimeout: 100,
                    maxTimeout: 2000,
                    factor: 1.5,
                    onFailedAttempt: (context) => {
                        this.logger.warn(
                            `▸ XRay Core status check, ${context.attemptNumber}/${context.attemptNumber + context.retriesLeft} · elapsed ${ems(
                                performance.now() - tm,
                                {
                                    extends: 'short',
                                    includeMs: true,
                                },
                            )} · retrying in ${context.retryDelay}ms`,
                        );
                    },
                },
            );

            return { isStarted: true, error: null };
        } catch (error) {
            this.logger.error(`Failed to get Xray internal status: ${error}`);

            return {
                isStarted: false,
                error:
                    error instanceof XrayProcessDownError
                        ? error.message
                        : 'Xray Core did not become ready in time',
            };
        }
    }

    private async restartXrayProcess(): Promise<{
        error: string | null;
    }> {
        try {
            await this.drainStats();

            await this.xrayProcess.stop();

            await this.commandBus.execute(new RunPreStartCommand());

            await this.xrayProcess.start();

            return { error: null };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Stopping the core resets its traffic counters: move them to the panel buffers first.
     */
    private async drainStats(): Promise<void> {
        if (!this.isXrayOnline) return;

        try {
            await this.commandBus.execute(new DrainStatsCommand());
        } catch (error) {
            this.logger.warn(`Failed to drain stats before core stop: ${error}`);
        }
    }

    public async tailLogLines(path: string, n = 10): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('tail', ['-n', String(n), path]);
            return stdout.split('\n').filter(Boolean);
        } catch {
            return [];
        }
    }

    private async dumpTailBlock(path: string, lines: number): Promise<string[]> {
        const tail = await this.tailLogLines(path, lines);
        if (tail.length === 0) return tail;

        this.logger.error(
            [
                'Xray Core Log Tail',
                `${'─'.repeat(8)} ${path} (${tail.length} lines) ${'─'.repeat(8)}`,
                ...tail.map((l) => `│ ${l}`),
            ].join('\n'),
        );

        return tail;
    }
}
