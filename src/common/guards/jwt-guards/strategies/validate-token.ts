import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';

import { getPanel, getRequestPanelId } from '@common/multi-panel';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'registeredUserJWT') {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            // Each panel connects to its own port and is verified with its own JWT public key.
            secretOrKeyProvider: (
                request: Request,
                _rawJwtToken: unknown,
                done: (err: unknown, secretOrKey?: string) => void,
            ) => {
                const panel = getPanel(getRequestPanelId(request));

                if (!panel) {
                    return done(new Error('Unknown panel'));
                }

                return done(null, panel.payload.jwtPublicKey);
            },
            algorithms: ['RS256'],
        });
    }

    async validate(JWTPrivatePayload: unknown): Promise<unknown> {
        return JWTPrivatePayload;
    }
}
