import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload/decode-node-payload';
import { INodePayload } from '@common/utils/decode-node-payload/node-payload.interface';

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
    secretKey: string;
    payload: INodePayload;
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
 *  - Panel N:  SECRET_KEY_N + NODE_PORT_N   (N = 2 … MAX_PANELS, gaps are allowed)
 */
export function parsePanelsFromEnv(env: NodeJS.ProcessEnv = process.env): IPanelDefinition[] {
    const panels: IPanelDefinition[] = [];

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

        if (!rawPort) {
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

        panels.push({
            id,
            label: `panel #${id}`,
            port: parsePort(rawPort, portEnv),
            secretKey,
            payload,
        });
    }

    const ports = new Set<number>();

    for (const panel of panels) {
        if (ports.has(panel.port)) {
            throw new Error(
                `Port ${panel.port} is used by more than one panel. Each panel must have its own NODE_PORT_N.`,
            );
        }

        ports.add(panel.port);
    }

    return panels;
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
