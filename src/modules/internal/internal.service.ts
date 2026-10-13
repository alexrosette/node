import { getSemaphore } from '@henrygd/semaphore';
import ems from 'enhanced-ms';

import { Injectable, Logger } from '@nestjs/common';

import { HashedSet } from '@remnawave/hashed-set';

import { PRIMARY_PANEL_ID, toXrayEmail } from '@common/multi-panel';
import { StartXrayCommand } from '@libs/contracts/commands';

export type TXrayClient = Record<string, unknown> & { email?: string };
export type TXrayInbound = {
    tag?: string;
    protocol?: string;
    settings?: Record<string, unknown> & { clients?: TXrayClient[] };
    [key: string]: unknown;
};

/** tag -> email -> client */
export type TPanelClients = Map<string, Map<string, TXrayClient>>;

type THashes = StartXrayCommand.Request['internals']['hashes'];

class PanelUsersState {
    /** Hash of the panel's config without users (sent by the panel). */
    public emptyConfigHash: null | string = null;
    /** tag -> set of user uuids, mirrors the hash computed by the panel. */
    public readonly inboundsHashMap = new Map<string, HashedSet>();
    /** Authoritative list of the panel's clients per inbound. Used to build the merged config. */
    public readonly clients: TPanelClients = new Map();
}

@Injectable()
export class InternalService {
    private readonly logger = new Logger(InternalService.name);
    private readonly mutex = getSemaphore();

    /** Full config (with API inbound etc.) that is served to Xray Core. */
    private xrayConfig: null | Record<string, unknown> = null;

    /** Base config (users stripped) of the panel that last (re)started the core. */
    private template: null | Record<string, unknown> = null;
    private templateHash: null | string = null;
    private templateOwner: null | number = null;

    /** Turns the merged config into the full config (adds API inbound, stats, policy …). */
    private configDecorator: ((merged: Record<string, unknown>) => Record<string, unknown>) | null =
        null;

    /**
     * Users were changed through the API after the config was built. If s6 restarts the
     * core on its own (crash), it must get the actual users of every panel.
     */
    private isConfigDirty = false;

    private readonly panels = new Map<number, PanelUsersState>();
    private readonly xtlsConfigInbounds: Set<string> = new Set();

    constructor() {}

    public async getXrayConfig(): Promise<Record<string, unknown>> {
        if (this.isConfigDirty && this.template && this.configDecorator) {
            try {
                this.xrayConfig = this.configDecorator(this.buildMergedConfig());
                this.isConfigDirty = false;
            } catch (error) {
                this.logger.error(`Failed to rebuild Xray config: ${error}`);
            }
        }

        if (!this.xrayConfig) {
            return {};
        }

        return this.xrayConfig;
    }

    public setXrayConfig(
        config: Record<string, unknown>,
        decorator?: (merged: Record<string, unknown>) => Record<string, unknown>,
    ): void {
        this.xrayConfig = config;
        this.isConfigDirty = false;

        if (decorator) {
            this.configDecorator = decorator;
        }
    }

    public getTemplateHash(): null | string {
        return this.templateHash;
    }

    public hasTemplate(): boolean {
        return this.template !== null;
    }

    public getActivePanelIds(): number[] {
        return [...this.panels.keys()].sort((a, b) => a - b);
    }

    public hasPanel(panelId: number): boolean {
        return this.panels.has(panelId);
    }

    /**
     * Rewrites `email` of every inbound client so users of different panels don't collide.
     * Returns the same object for the primary panel.
     */
    public namespaceConfigUsers(
        panelId: number,
        config: Record<string, unknown>,
    ): Record<string, unknown> {
        if (panelId === PRIMARY_PANEL_ID || !Array.isArray(config.inbounds)) {
            return config;
        }

        return {
            ...config,
            inbounds: (config.inbounds as TXrayInbound[]).map((inbound) => {
                const clients = inbound?.settings?.clients;

                if (!Array.isArray(clients)) {
                    return inbound;
                }

                return {
                    ...inbound,
                    settings: {
                        ...inbound.settings,
                        clients: clients.map((client) =>
                            typeof client?.email === 'string'
                                ? { ...client, email: toXrayEmail(panelId, client.email) }
                                : client,
                        ),
                    },
                };
            }),
        };
    }

    /**
     * Replaces the state of a single panel with users from its config.
     * Users of other panels are not touched.
     */
    public async ingestPanelConfig(
        panelId: number,
        hashes: THashes,
        config: Record<string, unknown>,
    ): Promise<void> {
        await this.mutex.acquire();

        try {
            const start = performance.now();
            const state = new PanelUsersState();

            state.emptyConfigHash = hashes.emptyConfig;

            this.logger.debug(JSON.stringify(hashes));
            this.logger.log(`[panel #${panelId}] Starting user extraction from inbounds...`);
            this.logger.log(`▸ Empty Config Hash: ${state.emptyConfigHash}`);

            if (Array.isArray(config.inbounds)) {
                const validTags = new Set(hashes.inbounds.map((item) => item.tag));
                const remoteHashByTag = new Map(hashes.inbounds.map((i) => [i.tag, i.hash]));

                for (const inbound of config.inbounds as TXrayInbound[]) {
                    const inboundTag = inbound?.tag;

                    if (!inboundTag || !validTags.has(inboundTag)) {
                        continue;
                    }

                    const usersSet = new HashedSet();
                    const clientsMap = new Map<string, TXrayClient>();

                    const clients = inbound.settings?.clients;

                    if (Array.isArray(clients)) {
                        for (const client of clients) {
                            if (typeof client?.id === 'string') {
                                usersSet.add(client.id);
                            }

                            if (typeof client?.email === 'string') {
                                clientsMap.set(client.email, client);
                            }
                        }
                    }

                    state.inboundsHashMap.set(inboundTag, usersSet);
                    state.clients.set(inboundTag, clientsMap);
                    this.xtlsConfigInbounds.add(inboundTag);

                    this.logger.log(
                        `▸ ${inboundTag} · ${String(usersSet.size)} users · ${usersSet.hash64String} (${remoteHashByTag.get(inboundTag) ?? 'N/A'})`,
                    );
                }
            }

            this.panels.set(panelId, state);

            const result = ems(performance.now() - start, {
                extends: 'short',
                includeMs: true,
            });

            this.logger.log(`User extraction completed in ${result ? result : '0ms'}`);
        } finally {
            this.mutex.release();
        }
    }

    /**
     * Stores the base config which is used for every panel. Clients are stripped,
     * they are taken from the per-panel state when the merged config is built.
     */
    public setTemplate(panelId: number, config: Record<string, unknown>, hash: string): void {
        if (this.templateHash !== null && this.templateHash !== hash) {
            this.logger.warn(
                `[panel #${panelId}] Base Xray config differs from the one previously applied (${this.templateHash} → ${hash}). ` +
                    'All panels attached to this node should use the same config profile.',
            );
        }

        this.template = {
            ...config,
            inbounds: Array.isArray(config.inbounds)
                ? (config.inbounds as TXrayInbound[]).map((inbound) =>
                      Array.isArray(inbound?.settings?.clients)
                          ? { ...inbound, settings: { ...inbound.settings, clients: [] } }
                          : inbound,
                  )
                : config.inbounds,
        };
        this.templateHash = hash;
        this.templateOwner = panelId;
    }

    public getTemplateInbound(tag: string): TXrayInbound | undefined {
        const inbounds = this.template?.inbounds;

        if (!Array.isArray(inbounds)) return undefined;

        return (inbounds as TXrayInbound[]).find((inbound) => inbound?.tag === tag);
    }

    /**
     * Template + clients of every active panel.
     */
    public buildMergedConfig(): Record<string, unknown> {
        if (!this.template) {
            throw new Error('Base config is not set');
        }

        const panelIds = this.getActivePanelIds();
        const templateTags = new Set<string>();

        const inbounds = Array.isArray(this.template.inbounds)
            ? (this.template.inbounds as TXrayInbound[]).map((inbound) => {
                  const tag = inbound?.tag;

                  if (!tag) return inbound;

                  templateTags.add(tag);

                  const merged: TXrayClient[] = [];

                  for (const panelId of panelIds) {
                      const clients = this.panels.get(panelId)?.clients.get(tag);

                      if (clients) {
                          merged.push(...clients.values());
                      }
                  }

                  if (merged.length === 0 && !Array.isArray(inbound.settings?.clients)) {
                      return inbound;
                  }

                  return {
                      ...inbound,
                      settings: {
                          ...inbound.settings,
                          clients: merged,
                      },
                  };
              })
            : this.template.inbounds;

        for (const panelId of panelIds) {
            const state = this.panels.get(panelId)!;

            for (const tag of state.clients.keys()) {
                if (!templateTags.has(tag)) {
                    this.logger.warn(
                        `[panel #${panelId}] Inbound "${tag}" does not exist in the current base config, its users are skipped.`,
                    );
                }
            }
        }

        const totalUsers = panelIds
            .map((id) => {
                let count = 0;
                for (const clients of this.panels.get(id)!.clients.values()) {
                    count += clients.size;
                }
                return `#${id}: ${count}`;
            })
            .join(', ');

        this.logger.log(
            `Merged config built from ${panelIds.length} panel(s) (base from panel #${this.templateOwner}) · users per panel → ${totalUsers || 'none'}`,
        );

        return { ...this.template, inbounds };
    }

    public isNeedRestartCore(panelId: number, incomingHashes: THashes): boolean {
        const start = performance.now();
        try {
            const state = this.panels.get(panelId);

            if (!state || !state.emptyConfigHash) {
                this.logger.warn(`[panel #${panelId}] Panel is not synced with this node yet`);
                return true;
            }

            if (incomingHashes.emptyConfig !== state.emptyConfigHash) {
                this.logger.warn('Detected changes in Xray Core base configuration');
                return true;
            }

            if (incomingHashes.emptyConfig !== this.templateHash) {
                this.logger.warn(
                    `[panel #${panelId}] Running base configuration was applied by another panel and differs`,
                );
                return true;
            }

            if (incomingHashes.inbounds.length !== state.inboundsHashMap.size) {
                this.logger.warn('Number of Xray Core inbounds has changed');
                return true;
            }

            for (const [inboundTag, usersSet] of state.inboundsHashMap) {
                const incomingInbound = incomingHashes.inbounds.find(
                    (item) => item.tag === inboundTag,
                );

                if (!incomingInbound) {
                    this.logger.warn(
                        `Inbound ${inboundTag} no longer exists in Xray Core configuration`,
                    );
                    return true;
                }

                if (usersSet.hash64String !== incomingInbound.hash) {
                    this.logger.warn(
                        `User configuration changed for inbound ${inboundTag} (${usersSet.hash64String} → ${incomingInbound.hash})`,
                    );
                    return true;
                }
            }

            this.logger.log(
                `[panel #${panelId}] Xray Core configuration is up-to-date - no restart required`,
            );

            return false;
        } catch (error) {
            this.logger.error(`Failed to check if Xray Core restart is needed: ${error}`);
            return true;
        } finally {
            const result = ems(performance.now() - start, {
                extends: 'short',
                includeMs: true,
            });
            this.logger.log(`Configuration hash check completed in ${result ? result : '0ms'}`);
        }
    }

    /**
     * Deep-enough copy of the panel clients (maps are copied, client objects are shared).
     */
    public getPanelClients(panelId: number): TPanelClients {
        const snapshot: TPanelClients = new Map();
        const state = this.panels.get(panelId);

        if (!state) return snapshot;

        for (const [tag, clients] of state.clients) {
            snapshot.set(tag, new Map(clients));
        }

        return snapshot;
    }

    public removePanel(panelId: number): void {
        this.panels.delete(panelId);

        this.logger.log(`[panel #${panelId}] Panel state removed.`);

        if (this.panels.size === 0) {
            this.cleanup();
        }
    }

    public async addUserToInbound(
        panelId: number,
        inboundTag: string,
        user: string,
        client?: TXrayClient,
    ): Promise<void> {
        await this.mutex.acquire();

        try {
            const state = this.getOrCreatePanelState(panelId);

            const usersSet = state.inboundsHashMap.get(inboundTag);

            if (!usersSet) {
                this.logger.warn(
                    `Inbound ${inboundTag} not found in inboundsHashMap, creating new one`,
                );

                state.inboundsHashMap.set(inboundTag, new HashedSet([user]));
            } else {
                usersSet.add(user);
            }

            if (client && typeof client.email === 'string') {
                let clients = state.clients.get(inboundTag);

                if (!clients) {
                    clients = new Map();
                    state.clients.set(inboundTag, clients);
                }

                clients.set(client.email, client);
            }

            this.isConfigDirty = true;
        } catch (error) {
            this.logger.error(`Failed to add user to inbound ${inboundTag}: ${error}`);
        } finally {
            this.mutex.release();
        }
    }

    public async removeUserFromInbound(
        panelId: number,
        inboundTag: string,
        user: string,
        email?: string,
    ): Promise<void> {
        await this.mutex.acquire();

        try {
            const state = this.panels.get(panelId);

            if (!state) {
                return;
            }

            if (email !== undefined && state.clients.get(inboundTag)?.delete(email)) {
                this.isConfigDirty = true;
            }

            const usersSet = state.inboundsHashMap.get(inboundTag);

            if (!usersSet) {
                return;
            }

            usersSet.delete(user);

            if (usersSet.size === 0) {
                state.inboundsHashMap.delete(inboundTag);

                if (state.clients.get(inboundTag)?.size === 0) {
                    state.clients.delete(inboundTag);
                }

                this.logger.warn(
                    `[panel #${panelId}] Inbound ${inboundTag} has no users, clearing inboundsHashMap.`,
                );
            }
        } catch (error) {
            this.logger.error(`Failed to remove user from inbound ${inboundTag}: ${error}`);
        } finally {
            this.mutex.release();
        }
    }

    public getXtlsConfigInbounds(): Set<string> {
        return this.xtlsConfigInbounds;
    }

    public addXtlsConfigInbound(inboundTag: string): void {
        this.xtlsConfigInbounds.add(inboundTag);
    }

    public cleanup(): void {
        this.logger.log('Cleaning up internal service.');

        this.panels.clear();
        this.xtlsConfigInbounds.clear();
        this.xrayConfig = null;
        this.configDecorator = null;
        this.isConfigDirty = false;
        this.template = null;
        this.templateHash = null;
        this.templateOwner = null;
    }

    private getOrCreatePanelState(panelId: number): PanelUsersState {
        let state = this.panels.get(panelId);

        if (!state) {
            state = new PanelUsersState();
            this.panels.set(panelId, state);
        }

        return state;
    }
}
