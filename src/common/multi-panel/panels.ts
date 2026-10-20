import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload/decode-node-payload';
import { deriveSni } from '@common/utils/decode-node-payload/decode-servername.util';
import { INodePayload } from '@common/utils/decode-node-payload/node-payload.interface';

import { getLedger, ILedgerIdentity, LEDGER_ID } from './ledger';

export const PRIMARY_PANEL_ID = 1 as const;

/**
 * Max panel index that is scanned in env (SECRET_KEY_2 … SECRET_KEY_N).
 */
export const MAX_PANELS = 32 as const;

export interface IPanelDefinition {
    /** 1-based panel index. Panel 1 is configured by SECRET_KEY / NODE_PORT. */
    id: number;
    /** Human readable label used in logs. */
    label: string;
    port: number;
    /** true when the panel has no own NODE_PORT_N and uses the shared NODE_PORT. */
    sharedPort: boolean;
    /** SNI the panel sends when connecting (derived from its CA + JWT key). */
    sni: string;
    secretKey: string;
    payload: INodePayload;
}

export interface IPanelListener {
    port: number;
    panels: IPanelDefinition[];
    /** Several panels on one port: TLS context and panel are selected by SNI. */
    isShared: boolean;
    /** Ledger listens on NODE_PORT next to panel #1 (the listener is then always shared). */
    ledger: ILedgerIdentity | null;
}

let cachedPanels: IPanelDefinition[] | null = null;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = env[name];

    if (value === undefined) return undefined;

    const trimmed = value.trim();

    return trimmed === '' || trimmed === '""' ? undefined : trimmed;
}

function parsePort(raw: string, envName: string): number {
    const port = Number.parseInt(raw, 10);

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`${envName} must be a valid TCP port, got "${raw}".`);
    }

    return port;
}

/**
 * Reads panel definitions from the environment.
 *
 *  - Panel 1:  SECRET_KEY   + NODE_PORT
 *  - Panel N:  SECRET_KEY_N [+ NODE_PORT_N]   (N = 2 … MAX_PANELS, gaps are allowed)
 *
 * Without NODE_PORT_N the panel shares NODE_PORT with panel 1. Panels on the same port
 * are told apart by the SNI they send (Remnawave panel >= 3.3 always sends it).
 */
export function parsePanelsFromEnv(env: NodeJS.ProcessEnv = process.env): IPanelDefinition[] {
    const panels: IPanelDefinition[] = [];

    let sharedPort: number | null = null;

    for (let id = 1; id <= MAX_PANELS; id++) {
        const secretEnv = id === PRIMARY_PANEL_ID ? 'SECRET_KEY' : `SECRET_KEY_${id}`;
        const portEnv = id === PRIMARY_PANEL_ID ? 'NODE_PORT' : `NODE_PORT_${id}`;

        const secretKey = readEnv(env, secretEnv);

        if (!secretKey) {
            if (id === PRIMARY_PANEL_ID) {
                throw new Error('SECRET_KEY missing in environment variables.');
            }

            if (readEnv(env, portEnv)) {
                throw new Error(`${portEnv} is set, but ${secretEnv} is missing.`);
            }

            continue;
        }

        const rawPort = readEnv(env, portEnv);

        if (!rawPort && id === PRIMARY_PANEL_ID) {
            throw new Error(`${secretEnv} is set, but ${portEnv} is missing.`);
        }

        let payload: INodePayload;

        try {
            payload = parseNodePayloadFromConfigService(secretKey);
        } catch (error) {
            throw new Error(
                `${secretEnv}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const port: number = rawPort ? parsePort(rawPort, portEnv) : sharedPort!;

        if (id === PRIMARY_PANEL_ID) {
            sharedPort = port;
        }

        panels.push({
            id,
            label: `panel #${id}`,
            port,
            sharedPort: !rawPort,
            sni: deriveSni(payload.caCertPem, payload.jwtPublicKey),
            secretKey,
            payload,
        });
    }

    for (const listener of groupPanelsByPort(panels, getLedger())) {
        const seen = new Map<string, number>();

        if (listener.ledger) {
            seen.set(listener.ledger.sni, LEDGER_ID);
        }

        for (const panel of listener.panels) {
            const duplicate = seen.get(panel.sni);

            if (duplicate === LEDGER_ID) {
                throw new Error(
                    `Panel #${panel.id} uses the same key as LEDGER_SECRET_KEY on port ${listener.port}.`,
                );
            }

            if (duplicate !== undefined) {
                throw new Error(
                    `Panels #${duplicate} and #${panel.id} use the same SECRET_KEY on port ${listener.port}.`,
                );
            }

            seen.set(panel.sni, panel.id);
        }
    }

    return panels;
}

function groupPanelsByPort(
    panels: IPanelDefinition[],
    ledger: ILedgerIdentity | null,
): IPanelListener[] {
    const byPort = new Map<number, IPanelDefinition[]>();

    for (const panel of panels) {
        const list = byPort.get(panel.port) ?? [];
        list.push(panel);
        byPort.set(panel.port, list);
    }

    return [...byPort].map(([port, list]) => {
        const withLedger = ledger !== null && ledger.port === port ? ledger : null;

        return {
            port,
            panels: list,
            // With ledger the TLS context must be selected by SNI even for a single panel.
            isShared: list.length > 1 || withLedger !== null,
            ledger: withLedger,
        };
    });
}

/**
 * One listener per port. The listener of the primary panel (NODE_PORT) goes first.
 */
export function getPanelListeners(): IPanelListener[] {
    return groupPanelsByPort(getPanels(), getLedger());
}

/**
 * Resolves the panel of a connection on a shared port by the SNI it sent.
 * Ledger resolves to LEDGER_ID.
 */
export function getPanelIdBySni(servername: unknown): number | undefined {
    if (typeof servername !== 'string' || servername === '') return undefined;

    const panelId = getPanels().find((panel) => panel.sni === servername)?.id;

    if (panelId !== undefined) return panelId;

    return getLedger()?.sni === servername ? LEDGER_ID : undefined;
}

export function getPanels(): IPanelDefinition[] {
    if (!cachedPanels) {
        cachedPanels = parsePanelsFromEnv();
    }

    return cachedPanels;
}

export function getPanel(panelId: number): IPanelDefinition | undefined {
    return getPanels().find((panel) => panel.id === panelId);
}

export function getPanelIds(): number[] {
    return getPanels().map((panel) => panel.id);
}

export function isMultiPanel(): boolean {
    return getPanels().length > 1;
}
