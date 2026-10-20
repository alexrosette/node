import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload/decode-node-payload';
import { deriveSni } from '@common/utils/decode-node-payload/decode-servername.util';
import { INodePayload } from '@common/utils/decode-node-payload/node-payload.interface';

/**
 * Ledger is the control plane of the node (base config, core restart / stop, status).
 * It is not a panel: it has no users, no stats buffer and is never listed in getPanels().
 */
export const LEDGER_ID = 0 as const;

export const LEDGER_JWT_AUDIENCE = 'rw-node-ledger' as const;

export const LEDGER_ROUTE_PREFIX = '/node/ledger/' as const;

export interface ILedgerIdentity {
    id: typeof LEDGER_ID;
    label: 'ledger';
    /** Ledger shares NODE_PORT of panel #1, its TLS context is selected by SNI. */
    port: number;
    sni: string;
    payload: INodePayload;
}

let cachedLedger: ILedgerIdentity | null | undefined;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = env[name]?.trim();

    return value === undefined || value === '' || value === '""' ? undefined : value;
}

/**
 * LEDGER_SECRET_KEY has the same format as SECRET_KEY of a panel.
 * Without it the node works exactly as before.
 */
export function parseLedgerFromEnv(env: NodeJS.ProcessEnv = process.env): ILedgerIdentity | null {
    const secretKey = readEnv(env, 'LEDGER_SECRET_KEY');

    if (!secretKey) return null;

    let payload: INodePayload;

    try {
        payload = parseNodePayloadFromConfigService(secretKey);
    } catch (error) {
        throw new Error(
            `LEDGER_SECRET_KEY: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const rawPort = readEnv(env, 'NODE_PORT');
    const port = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('LEDGER_SECRET_KEY is set, but NODE_PORT is missing or invalid.');
    }

    return {
        id: LEDGER_ID,
        label: 'ledger',
        port,
        sni: deriveSni(payload.caCertPem, payload.jwtPublicKey),
        payload,
    };
}

export function getLedger(): ILedgerIdentity | null {
    if (cachedLedger === undefined) {
        cachedLedger = parseLedgerFromEnv();
    }

    return cachedLedger;
}

export function isLedgerMode(): boolean {
    return getLedger() !== null;
}

export function isLedgerPath(url: string | undefined): boolean {
    return url !== undefined && url.startsWith(LEDGER_ROUTE_PREFIX);
}
