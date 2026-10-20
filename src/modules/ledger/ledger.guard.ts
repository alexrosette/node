import { Request } from 'express';
import { createPublicKey, KeyObject, verify } from 'node:crypto';

import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';

import { getLedger, getRequestPanelId, LEDGER_ID, LEDGER_JWT_AUDIENCE } from '@common/multi-panel';

const MAX_TOKEN_LIFETIME_SEC = 60;
const CLOCK_TOLERANCE_SEC = 5;
const JTI_MEMORY_MS = 120_000;

interface ILedgerClaims {
    aud?: unknown;
    iat?: unknown;
    exp?: unknown;
    jti?: unknown;
}

function decodeSegment(segment: string): unknown {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Ledger authorization: mTLS (by its own CA, checked in the TLS handshake) + a short-lived
 * RS256 JWT signed by the ledger key. Every token can be used only once (jti).
 */
@Injectable()
export class LedgerGuard implements CanActivate {
    private readonly logger = new Logger('LedgerGuard');
    private readonly seenJti = new Map<string, number>();
    private publicKey: KeyObject | null = null;

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const where = `${req.method} ${req.originalUrl ?? req.url}, IP: ${req.ip}`;

        const result = this.check(req);

        if (typeof result === 'string') {
            this.logger.error(`[ledger] Request dropped (${result}). ${where}`);

            context.switchToHttp().getResponse().socket?.destroy();
            throw new UnauthorizedException('Unauthorized');
        }

        this.logger.log(`[ledger] ${req.method} ${req.originalUrl ?? req.url} jti=${result.jti}`);

        return true;
    }

    /**
     * Returns the reason of the refusal, or the verified token.
     */
    private check(req: Request): string | { jti: string } {
        const ledger = getLedger();

        if (!ledger) return 'ledger is not configured';
        if (getRequestPanelId(req) !== LEDGER_ID) return 'not a ledger connection';

        const header = req.headers.authorization;

        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            return 'no bearer token';
        }

        const parts = header.slice('Bearer '.length).trim().split('.');

        if (parts.length !== 3) return 'malformed token';

        let jwtHeader: { alg?: unknown };
        let claims: ILedgerClaims;

        try {
            jwtHeader = decodeSegment(parts[0]) as { alg?: unknown };
            claims = decodeSegment(parts[1]) as ILedgerClaims;
        } catch {
            return 'malformed token';
        }

        if (jwtHeader.alg !== 'RS256') return 'unsupported alg';

        this.publicKey ??= createPublicKey(ledger.payload.jwtPublicKey);

        const isValid = verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            this.publicKey,
            Buffer.from(parts[2], 'base64url'),
        );

        if (!isValid) return 'bad signature';

        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

        if (!audience.includes(LEDGER_JWT_AUDIENCE)) return 'bad audience';

        const { iat, exp, jti } = claims;

        if (typeof iat !== 'number' || typeof exp !== 'number') return 'no iat/exp';
        if (exp - iat > MAX_TOKEN_LIFETIME_SEC) return 'token lives too long';

        const now = Date.now() / 1000;

        if (exp + CLOCK_TOLERANCE_SEC < now) return 'token expired';
        if (iat - CLOCK_TOLERANCE_SEC > now) return 'token issued in the future';

        if (typeof jti !== 'string' || jti === '' || jti.length > 128) return 'no jti';

        const nowMs = Date.now();

        for (const [seen, expiresAt] of this.seenJti) {
            if (expiresAt <= nowMs) this.seenJti.delete(seen);
        }

        if (this.seenJti.has(jti)) return 'replayed jti';

        this.seenJti.set(jti, nowMs + JTI_MEMORY_MS);

        return { jti };
    }
}
