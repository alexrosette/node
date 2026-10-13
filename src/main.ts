process.title = 'rw-node';
import 'zod/compile';
import * as bodyParser from '@kastov/body-parser-with-zstd';
import compression from 'compression';
import express, { json } from 'express';
import helmet from 'helmet';
import { createServer, Server } from 'https';
import morgan from 'morgan';
import { utilities as nestWinstonModuleUtilities, WinstonModule } from 'nest-winston';
import { ZodValidationPipe } from 'nestjs-zod';
import { createSecureContext, SecureContext, SecureVersion } from 'node:tls';
import { createLogger } from 'winston';
import * as winston from 'winston';

import { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { NestFactory } from '@nestjs/core';

import { TypedConfigService } from '@common/config/app-config/typed-config.service';
import { NotFoundExceptionFilter } from '@common/exception';
import { getPanels, IPanelDefinition, setRequestPanelId } from '@common/multi-panel';
import { acquireInstanceLock } from '@common/utils/acquire-instance-lock';
import { parseNodePayload } from '@common/utils/decode-node-payload';
import { makeSniVerifier } from '@common/utils/decode-node-payload/decode-servername.util';
import { INodePayload } from '@common/utils/decode-node-payload/node-payload.interface';
import { assertPayloadIntegrity } from '@common/utils/decode-node-payload/validate-secret-key.util';
import { customLogFilter } from '@common/utils/filter-logs';
import { getDuplicateInstanceMessage } from '@common/utils/get-duplicate-instance-message';
import { getStartMessage } from '@common/utils/get-start-message';
import { isDevelopment } from '@common/utils/is-development';
import { ROOT } from '@libs/contracts/api';
import {
    XRAY_INTERNAL_FULL_PATH,
    XRAY_INTERNAL_FULL_WEBHOOK_PATH,
} from '@libs/contracts/constants';

import { AppModule } from './app.module';

const logger = createLogger({
    transports: [new winston.transports.Console()],
    format: winston.format.combine(
        customLogFilter(),
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss.SSS',
        }),
        winston.format.align(),
        // winston.format.ms(),
        nestWinstonModuleUtilities.format.nestLike('', {
            colors: true,
            prettyPrint: true,
            processId: false,
            appName: false,
        }),
    ),
    level: isDevelopment() ? 'debug' : 'info',
});

function buildHttpsOptions(
    nodePayload: INodePayload,
    sniVerification: boolean,
): { minVersion?: SecureVersion } & HttpsOptions {
    let tlsCertOptions: HttpsOptions;

    if (sniVerification) {
        const realCtx: SecureContext = createSecureContext({
            key: nodePayload.nodeKeyPem,
            cert: nodePayload.nodeCertPem,
            ca: [nodePayload.caCertPem],
            minVersion: 'TLSv1.3',
        });

        const verifySni = makeSniVerifier(nodePayload.caCertPem, nodePayload.jwtPublicKey);

        tlsCertOptions = {
            SNICallback: (
                servername: string,
                cb: (err: Error | null, ctx?: SecureContext) => void,
            ) => (verifySni(servername) ? cb(null, realCtx) : cb(new Error('unknown sni'))),
        } as HttpsOptions;
    } else {
        tlsCertOptions = {
            key: nodePayload.nodeKeyPem,
            cert: nodePayload.nodeCertPem,
            ca: [nodePayload.caCertPem],
        } satisfies HttpsOptions;
    }

    return {
        ...tlsCertOptions,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
    } as { minVersion?: SecureVersion } & HttpsOptions;
}

function getSecondaryPanels(): IPanelDefinition[] {
    const [, ...secondary] = getPanels();

    for (const panel of secondary) {
        logger.info(`Validating SECRET_KEY_${panel.id} (${panel.label}, port ${panel.port})...`);
        assertPayloadIntegrity(panel.payload, logger);
    }

    return secondary;
}

async function bootstrap(): Promise<void> {
    const internalSocketPath = process.env.INTERNAL_SOCKET_PATH!;
    const sniVerification = process.env.SNI_VERIFICATION === 'true';

    const nodePayload = parseNodePayload(logger);
    const secondaryPanels = getSecondaryPanels();

    const httpsOptions = buildHttpsOptions(nodePayload, sniVerification);

    const app = await NestFactory.create(AppModule, {
        httpsOptions,
        bodyParser: false,
        logger: WinstonModule.createLogger({
            instance: logger,
        }),
    });

    app.use(
        bodyParser.json({
            limit: '1000mb',
        }),
    );

    const nodeHttpServer: Server = app.getHttpServer();
    nodeHttpServer.keepAliveTimeout = 60_000;
    nodeHttpServer.headersTimeout = 61_000;

    // app.use(json({ limit: '1000mb' }));

    app.use(compression());

    const config = app.get(TypedConfigService);

    app.use(helmet());

    if (isDevelopment()) {
        app.use(morgan('short'));
    }

    app.useGlobalFilters(new NotFoundExceptionFilter());

    app.setGlobalPrefix(ROOT, {
        exclude: [XRAY_INTERNAL_FULL_PATH, XRAY_INTERNAL_FULL_WEBHOOK_PATH],
    });

    app.useGlobalPipes(new ZodValidationPipe());

    await app.listen(config.getOrThrow('NODE_PORT'));

    const httpAdapter = app.getHttpAdapter();
    const httpServer = httpAdapter.getInstance();

    const internalApp = express();
    internalApp.use(json({ limit: '1000mb' }));

    // '/' + REST_API.VISION.BLOCK_IP, '/' + REST_API.VISION.UNBLOCK_IP
    internalApp.use(
        [XRAY_INTERNAL_FULL_PATH, XRAY_INTERNAL_FULL_WEBHOOK_PATH],
        (req, res, next) => {
            req.url = req.originalUrl;

            httpServer.handle(req, res, next);
        },
    );

    const internalServer = internalApp.listen('\0' + internalSocketPath);

    // Every additional panel gets its own mTLS listener (own CA / cert / JWT key).
    // Requests are tagged with the panel id and handled by the same Nest application.
    const panelServers: Server[] = [];

    for (const panel of secondaryPanels) {
        const panelServer = createServer(
            buildHttpsOptions(panel.payload, sniVerification),
            (req, res) => {
                setRequestPanelId(req, panel.id);
                httpServer(req, res);
            },
        );

        panelServer.keepAliveTimeout = 60_000;
        panelServer.headersTimeout = 61_000;

        await new Promise<void>((resolve, reject) => {
            panelServer.once('error', reject);
            panelServer.listen(panel.port, () => {
                panelServer.off('error', reject);
                resolve();
            });
        });

        panelServers.push(panelServer);

        logger.info(`Listening for ${panel.label} on port ${panel.port}`);
    }

    let internalServerClosed = false;

    const closeInternalServer = () => {
        if (internalServerClosed) return;
        internalServerClosed = true;

        internalServer.close(() => {
            logger.info('Shutting down...');
        });

        for (const panelServer of panelServers) {
            panelServer.close();
        }
    };

    app.enableShutdownHooks();

    process.on('SIGINT', closeInternalServer);
    process.on('SIGTERM', closeInternalServer);

    logger.info('\n' + (await getStartMessage(config.getOrThrow('NODE_PORT'), app)) + '\n');

    if (!(await acquireInstanceLock())) {
        logger.error('\n' + getDuplicateInstanceMessage() + '\n');
    }

    if (import.meta.webpackHot) {
        import.meta.webpackHot.accept();
        import.meta.webpackHot.dispose(() => {
            for (const panelServer of panelServers) {
                panelServer.close();
            }

            return app.close();
        });
    }
}

void bootstrap().catch((e) => {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
