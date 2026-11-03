import { IncomingMessage } from 'node:http';

import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload/decode-node-payload';
import { deriveSni } from '@common/utils/decode-node-payload/decode-servername.util';
import { INodePayload } from '@common/utils/decode-node-payload/node-payload.interface';

/**
 * Ledger: a second TLS identity on NODE_PORT, selected by SNI, that may only read the node
 * status and restart the core (/node/ledger/*). It is not a panel and never sends configs.
 * Without LEDGER_SECRET_KEY the node behaves exactly like upstream.
 */
export const LEDGER_JWT_AUDIENCE = 'rw-node-ledger' as const;

export const LEDGER_ROUTE_PREFIX = '/node/ledger/' as const;

export interface ILedgerIdentity {
    sni: string;
    payload: INodePayload;
}

let cachedLedger: ILedgerIdentity | null | undefined;

/**
 * LEDGER_SECRET_KEY has the same format as SECRET_KEY of a panel.
 */
export function parseLedgerFromEnv(env: NodeJS.ProcessEnv = process.env): ILedgerIdentity | null {
    const secretKey = env.LEDGER_SECRET_KEY?.trim();

    if (!secretKey || secretKey === '""') return null;

    let payload: INodePayload;

    try {
        payload = parseNodePayloadFromConfigService(secretKey);
    } catch (error) {
        throw new Error(
            `LEDGER_SECRET_KEY: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return { sni: deriveSni(payload.caCertPem, payload.jwtPublicKey), payload };
}

export function getLedger(): ILedgerIdentity | null {
    if (cachedLedger === undefined) {
        cachedLedger = parseLedgerFromEnv();
    }

    return cachedLedger;
}

export function isLedgerPath(url: string | undefined): boolean {
    return url !== undefined && url.startsWith(LEDGER_ROUTE_PREFIX);
}

const LEDGER_REQUEST = Symbol('ledgerRequest');

type TTaggedRequest = IncomingMessage & { [LEDGER_REQUEST]?: boolean };

/** Set for every TLS request before routing: true if it came over the ledger identity. */
export function setLedgerRequest(req: IncomingMessage, isLedger: boolean): void {
    (req as TTaggedRequest)[LEDGER_REQUEST] = isLedger;
}

export function isLedgerRequest(req: IncomingMessage): boolean {
    return (req as TTaggedRequest)[LEDGER_REQUEST] === true;
}

export function isTaggedRequest(req: IncomingMessage): boolean {
    return (req as TTaggedRequest)[LEDGER_REQUEST] !== undefined;
}

const panelActivity = {
    lastRequestAt: null as Date | null,
    lastStartAt: null as Date | null,
};

export function markPanelRequest(): void {
    panelActivity.lastRequestAt = new Date();
}

export function markPanelStart(): void {
    panelActivity.lastStartAt = new Date();
}

export function getPanelActivity(): { lastRequestAt: Date | null; lastStartAt: Date | null } {
    return { ...panelActivity };
}
