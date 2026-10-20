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
import { IncomingMessage, ServerResponse } from 'node:http';
import { createSecureContext, SecureContext, SecureVersion, TLSSocket } from 'node:tls';
import { createLogger } from 'winston';
import * as winston from 'winston';

import { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { NestFactory } from '@nestjs/core';

import { TypedConfigService } from '@common/config/app-config/typed-config.service';
import { NotFoundExceptionFilter } from '@common/exception';
import {
    getLedger,
    getPanelIdBySni,
    getPanelListeners,
    getPanels,
    getRequestPanelId,
    hasRequestPanelId,
    IPanelListener,
    isLedgerPath,
    LEDGER_ID,
    markPanelRequest,
    setRequestPanelId,
} from '@common/multi-panel';
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
import { XrayService } from './modules/xray-core/xray.service';

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

/**
 * Several panels on one port: the node certificate (and the CA used to verify the panel's
 * client certificate) is selected by the SNI the panel sends. Unknown SNI is rejected.
 */
function buildSharedHttpsOptions(
    listener: IPanelListener,
): { minVersion?: SecureVersion } & HttpsOptions {
    const contexts = new Map<string, SecureContext>();

    for (const panel of listener.panels) {
        contexts.set(
            panel.sni,
            createSecureContext({
                key: panel.payload.nodeKeyPem,
                cert: panel.payload.nodeCertPem,
                ca: [panel.payload.caCertPem],
                minVersion: 'TLSv1.3',
            }),
        );
    }

    if (listener.ledger) {
        contexts.set(
            listener.ledger.sni,
            createSecureContext({
                key: listener.ledger.payload.nodeKeyPem,
                cert: listener.ledger.payload.nodeCertPem,
                ca: [listener.ledger.payload.caCertPem],
                minVersion: 'TLSv1.3',
            }),
        );
    }

    return {
        SNICallback: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
            const ctx = contexts.get(servername);

            return ctx ? cb(null, ctx) : cb(new Error('unknown sni'));
        },
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
    } as { minVersion?: SecureVersion } & HttpsOptions;
}

function buildListenerHttpsOptions(
    listener: IPanelListener,
    sniVerification: boolean,
): { minVersion?: SecureVersion } & HttpsOptions {
    return listener.isShared
        ? buildSharedHttpsOptions(listener)
        : buildHttpsOptions(listener.panels[0].payload, sniVerification);
}

/**
 * Marks the request with the panel it came from. Returns false if the panel is unknown.
 */
function tagPanelRequest(listener: IPanelListener, req: IncomingMessage): boolean {
    if (!listener.isShared) {
        setRequestPanelId(req, listener.panels[0].id);
        return true;
    }

    const socket = req.socket;
    const panelId =
        socket instanceof TLSSocket
            ? getPanelIdBySni((socket as TLSSocket & { servername?: unknown }).servername)
            : undefined;

    const isKnown =
        panelId !== undefined &&
        (listener.panels.some((panel) => panel.id === panelId) ||
            (panelId === LEDGER_ID && listener.ledger !== null));

    if (!isKnown) {
        socket.destroy();
        return false;
    }

    setRequestPanelId(req, panelId!);
    return true;
}

/**
 * Runs before every route. Requests from the network must carry the panel tag set by
 * tagPanelRequest (fail-closed), ledger may only call /node/ledger/*, panels may not.
 * Requests from the internal unix socket (Xray webhooks) are not tagged and pass through.
 */
function routeGuard(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    if (!(req.socket instanceof TLSSocket)) {
        next();
        return;
    }

    const isLedger = hasRequestPanelId(req) && getRequestPanelId(req) === LEDGER_ID;

    if (!hasRequestPanelId(req) || isLedger !== isLedgerPath(req.url)) {
        res.statusCode = 404;
        res.end(() => req.socket.destroy());
        return;
    }

    if (!isLedger) {
        markPanelRequest(getRequestPanelId(req));
    }

    next();
}

function validateSecondaryPanels(): void {
    const [, ...secondary] = getPanels();

    for (const panel of secondary) {
        logger.info(
            `Validating SECRET_KEY_${panel.id} (${panel.label}, port ${panel.port}${panel.sharedPort ? ', shared' : ''})...`,
        );
        assertPayloadIntegrity(panel.payload, logger);
    }

    const ledger = getLedger();

    if (ledger) {
        logger.info(`Validating LEDGER_SECRET_KEY (ledger, port ${ledger.port}, shared)...`);
        assertPayloadIntegrity(ledger.payload, logger);
    }
}

async function bootstrap(): Promise<void> {
    const internalSocketPath = process.env.INTERNAL_SOCKET_PATH!;
    const sniVerification = process.env.SNI_VERIFICATION === 'true';

    parseNodePayload(logger);
    validateSecondaryPanels();

    const [primaryListener, ...extraListeners] = getPanelListeners();

    const httpsOptions = buildListenerHttpsOptions(primaryListener, sniVerification);

    const app = await NestFactory.create(AppModule, {
        httpsOptions,
        bodyParser: false,
        logger: WinstonModule.createLogger({
            instance: logger,
        }),
    });

    app.use(routeGuard);

    app.use(
        bodyParser.json({
            limit: '1000mb',
        }),
    );

    const nodeHttpServer: Server = app.getHttpServer();
    nodeHttpServer.keepAliveTimeout = 60_000;
    nodeHttpServer.headersTimeout = 61_000;

    // Runs before the Nest/Express handler of the same request.
    nodeHttpServer.prependListener('request', (req: IncomingMessage) => {
        tagPanelRequest(primaryListener, req);
    });

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

    // Panels with their own NODE_PORT_N get their own mTLS listener (own CA / cert / JWT key).
    // Requests are tagged with the panel id and handled by the same Nest application.
    const panelServers: Server[] = [];

    for (const listener of extraListeners) {
        const panelServer = createServer(
            buildListenerHttpsOptions(listener, sniVerification),
            (req, res) => {
                if (tagPanelRequest(listener, req)) {
                    httpServer(req, res);
                }
            },
        );

        panelServer.keepAliveTimeout = 60_000;
        panelServer.headersTimeout = 61_000;

        await new Promise<void>((resolve, reject) => {
            panelServer.once('error', reject);
            panelServer.listen(listener.port, () => {
                panelServer.off('error', reject);
                resolve();
            });
        });

        panelServers.push(panelServer);

        logger.info(
            `Listening for ${listener.panels.map((panel) => panel.label).join(', ')} on port ${listener.port}`,
        );
    }

    // Ledger mode: start the core with the saved base right away (Xray reads its config
    // from the internal socket, which is listening by now).
    void app.get(XrayService).startFromSavedLedgerBase();

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
