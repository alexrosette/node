import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload';

export const configSchema = z
    .object({
        APP_PORT: z.string().optional(),
        NODE_PORT: z
            .string()
            .optional()
            .transform((port) => {
                if (!port) return undefined;
                return parseInt(port, 10);
            }),

        SSL_CERT: z.string().optional(),
        SECRET_KEY: z.string().optional(),
        JWT_PUBLIC_KEY: z.string().optional(),
        XTLS_IP: z.string().default('127.0.0.1'),
        XTLS_PORT: z.string().default('61000'),
        HAS_DEPRECATED_SSL_CERT: z
            .string()
            .default('false')
            .transform((val) => val === 'true'),
        HAS_DEPRECATED_APP_PORT: z
            .string()
            .default('false')
            .transform((val) => val === 'true'),
        DISABLE_HASHED_SET_CHECK: z
            .string()
            .default('false')
            .transform((val) => val === 'true'),
        ENABLE_DPI_OPTIMIZATION: z
            .string()
            .default('false')
            .transform((val) => val === 'true'),
        DPI_PREFERRED_TRANSPORT: z
            .enum(['reality', 'websocket', 'grpc', 'h2', 'quic', 'tcp', 'xhttp'])
            .default('reality')
            .optional(),
        ENABLE_XMUX_JUNK_TRAFFIC: z
            .string()
            .default('true')
            .transform((val) => val === 'true')
            .optional(),
        ENABLE_PACKET_SIGNATURE_MUTATION: z
            .string()
            .default('true')
            .transform((val) => val === 'true')
            .optional(),
        DPI_TLS_FINGERPRINT: z
            .enum(['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'randomized'])
            .default('chrome')
            .optional(),
    })
    .superRefine((data, ctx) => {
        if (!data.SSL_CERT && !data.SECRET_KEY) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'SECRET_KEY is required.',
            });
        }

        if (!data.SECRET_KEY && data.SSL_CERT) {
            data.SECRET_KEY = data.SSL_CERT;
            data.HAS_DEPRECATED_SSL_CERT = true;
            data.SSL_CERT = undefined;
        }

        if (data.SECRET_KEY) {
            try {
                const parsed = parseNodePayloadFromConfigService(data.SECRET_KEY);
                data.JWT_PUBLIC_KEY = parsed.jwtPublicKey;
            } catch {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid SECRET_KEY payload',
                });
            }
        }

        if (!data.NODE_PORT && data.APP_PORT) {
            data.NODE_PORT = parseInt(data.APP_PORT, 10);
            data.HAS_DEPRECATED_APP_PORT = true;
            data.APP_PORT = undefined;
        }

        if (!data.NODE_PORT) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'NODE_PORT is required.',
            });
        }
    });

export type ConfigSchema = z.infer<typeof configSchema>;
export class Env extends createZodDto(configSchema) {}
