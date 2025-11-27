import { Logger } from '@nestjs/common';

import {
    IDPIOptimizedConfig,
    ITLSConfig,
    IRealityConfig,
    IWebSocketConfig,
    IGRPCConfig,
    IHTTP2Config,
    IXHTTPConfig,
    IXMUXConfig,
    IPacketSignatureMutation,
} from '../interfaces/dpi-resistant.interfaces';

/**
 * Утилита для оптимизации конфигурации Xray для обхода DPI
 */
export class DPIOptimizer {
    private readonly logger = new Logger(DPIOptimizer.name);

    /**
     * Популярные домены для маскировки Reality
     * Используются реальные популярные сайты для лучшей маскировки
     */
    private readonly REALITY_DOMAINS = [
        'www.microsoft.com',
        'www.apple.com',
        'www.google.com',
        'www.cloudflare.com',
        'www.amazon.com',
        'www.facebook.com',
        'www.github.com',
        'www.stackoverflow.com',
        'www.reddit.com',
        'www.wikipedia.org',
    ];

    /**
     * Генерирует оптимизированную TLS конфигурацию для обхода DPI
     */
    public generateTLSConfig(config?: ITLSConfig): ITLSConfig {
        const defaultConfig: ITLSConfig = {
            minVersion: '1.3',
            maxVersion: '1.3',
            fingerprint: 'chrome', // Имитация Chrome - самый популярный браузер
            alpn: ['h2', 'http/1.1'], // Стандартные ALPN для Chrome
            rejectUnknownSni: false,
            allowInsecure: false,
        };

        return {
            ...defaultConfig,
            ...config,
        };
    }

    /**
     * Генерирует Reality конфигурацию
     * Reality - один из самых эффективных протоколов для обхода DPI
     */
    public generateRealityConfig(config?: Partial<IRealityConfig>): IRealityConfig | null {
        if (!config?.publicKey || !config?.shortId) {
            this.logger.warn('Reality config requires publicKey and shortId');
            return null;
        }

        // Выбираем случайный домен из списка популярных
        const randomDomain = this.REALITY_DOMAINS[Math.floor(Math.random() * this.REALITY_DOMAINS.length)];

        const defaultConfig: IRealityConfig = {
            publicKey: config.publicKey,
            shortId: config.shortId,
            serverNames: config.serverNames || [randomDomain],
            dest: config.dest || `${randomDomain}:443`,
            xver: config.xver || 0,
            minClientVer: config.minClientVer || '1.8.0',
            maxTimeDiff: config.maxTimeDiff || 60000,
        };

        return defaultConfig;
    }

    /**
     * Генерирует WebSocket конфигурацию с оптимизацией для DPI
     */
    public generateWebSocketConfig(path?: string): IWebSocketConfig {
        const wsPath = path || this.generateRandomPath();

        return {
            path: wsPath,
            headers: {
                Host: this.REALITY_DOMAINS[Math.floor(Math.random() * this.REALITY_DOMAINS.length)],
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            maxEarlyData: 2048,
            useBrowserForwarding: true,
        };
    }

    /**
     * Генерирует gRPC конфигурацию с оптимизацией для DPI
     * gRPC маскируется под Google сервисы
     */
    public generateGRPCConfig(serviceName?: string): IGRPCConfig {
        return {
            serviceName: serviceName || 'GunService',
            multiMode: true, // Мультиплексирование для лучшей производительности
            idle_timeout: 60,
            health_check_timeout: 20,
            permit_without_stream: false,
            initial_windows_size: 0,
        };
    }

    /**
     * Генерирует HTTP/2 конфигурацию
     */
    public generateHTTP2Config(): IHTTP2Config {
        const randomDomain = this.REALITY_DOMAINS[Math.floor(Math.random() * this.REALITY_DOMAINS.length)];

        return {
            host: [randomDomain],
            path: '/',
            method: 'GET',
            headers: {
                'User-Agent': [
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ],
                'Accept': ['*/*'],
                'Accept-Language': ['en-US,en;q=0.9'],
                'Accept-Encoding': ['gzip, deflate, br'],
            },
        };
    }

    /**
     * Генерирует оптимизированные policy настройки для обхода DPI
     */
    public generateOptimizedPolicy(): Record<string, unknown> {
        return {
            levels: {
                '0': {
                    handshake: 4, // Быстрое рукопожатие
                    connIdle: 300, // Долгие соединения для избежания переподключений
                    uplinkOnly: 2,
                    downlinkOnly: 5,
                    bufferSize: 4096, // Оптимальный размер буфера
                    statsUserUplink: true,
                    statsUserDownlink: true,
                    statsUserOnline: false,
                },
            },
            system: {
                statsInboundUplink: true,
                statsInboundDownlink: true,
                statsOutboundUplink: true,
                statsOutboundDownlink: true,
            },
        };
    }

    /**
     * Применяет DPI оптимизации к конфигурации Xray
     */
    public applyDPIOptimizations(
        config: Record<string, unknown>,
        dpiConfig?: IDPIOptimizedConfig,
    ): Record<string, unknown> {
        if (!dpiConfig?.enableDPIOptimization) {
            return config;
        }

        this.logger.log('Applying DPI-resistant optimizations to Xray configuration...');

        const optimizedConfig = { ...config };

        // Оптимизируем policy
        if (dpiConfig.policy || !optimizedConfig.policy) {
            optimizedConfig.policy = this.generateOptimizedPolicy();
        }

        // Применяем оптимизации к inbounds
        if (Array.isArray(optimizedConfig.inbounds)) {
            optimizedConfig.inbounds = (optimizedConfig.inbounds as any[]).map((inbound) => {
                return this.optimizeInbound(inbound, dpiConfig);
            });
        }

        return optimizedConfig;
    }

    /**
     * Оптимизирует отдельный inbound для обхода DPI
     */
    private optimizeInbound(inbound: any, dpiConfig: IDPIOptimizedConfig): any {
        const optimized = { ...inbound };

        // Если нет streamSettings, создаем их
        if (!optimized.streamSettings) {
            optimized.streamSettings = {};
        }

        const transport = dpiConfig.preferredTransport || 'reality';

        switch (transport) {
            case 'reality':
                if (dpiConfig.reality) {
                    const realityConfig = this.generateRealityConfig(dpiConfig.reality);
                    if (realityConfig) {
                        optimized.streamSettings = {
                            network: 'tcp',
                            security: 'reality',
                            realitySettings: realityConfig,
                            tlsSettings: this.generateTLSConfig(dpiConfig.tls),
                        };
                    }
                }
                break;

            case 'websocket':
                optimized.streamSettings = {
                    network: 'ws',
                    security: 'tls',
                    wsSettings: this.generateWebSocketConfig(dpiConfig.websocket?.path),
                    tlsSettings: this.generateTLSConfig(dpiConfig.tls),
                };
                break;

            case 'grpc':
                optimized.streamSettings = {
                    network: 'grpc',
                    security: 'tls',
                    grpcSettings: this.generateGRPCConfig(dpiConfig.grpc?.serviceName),
                    tlsSettings: this.generateTLSConfig(dpiConfig.tls),
                };
                break;

            case 'h2':
                optimized.streamSettings = {
                    network: 'h2',
                    security: 'tls',
                    httpSettings: this.generateHTTP2Config(),
                    tlsSettings: this.generateTLSConfig(dpiConfig.tls),
                };
                break;

            case 'xhttp':
                // XHTTP транспорт с максимальной маскировкой
                const xhttpConfig = this.generateXHTTPConfig(dpiConfig.xhttp);
                optimized.streamSettings = {
                    network: 'xhttp',
                    security: 'tls',
                    httpSettings: {
                        host: xhttpConfig.host,
                        path: xhttpConfig.path,
                        method: xhttpConfig.method,
                        headers: xhttpConfig.headers,
                    },
                    tlsSettings: this.generateTLSConfig(dpiConfig.tls),
                };
                // Добавляем настройки для мусорного трафика и изменения сигнатур
                if (xhttpConfig.enableJunkTraffic || xhttpConfig.enablePacketSignatureMutation) {
                    optimized.streamSettings.xhttpSettings = {
                        ...xhttpConfig,
                    };
                }
                break;

            case 'tcp':
            default:
                // Для TCP добавляем TLS с оптимизацией
                if (!optimized.streamSettings.security) {
                    optimized.streamSettings.security = 'tls';
                    optimized.streamSettings.tlsSettings = this.generateTLSConfig(dpiConfig.tls);
                }
                break;
        }

        // Добавляем XMUX конфигурацию для мультиплексирования и мусорного трафика
        if (dpiConfig.xmux?.enabled) {
            const xmuxConfig = this.generateXMUXConfig(dpiConfig.xmux);
            if (!optimized.mux) {
                optimized.mux = {};
            }
            optimized.mux = {
                enabled: xmuxConfig.enabled,
                concurrency: xmuxConfig.concurrency,
                // Добавляем настройки для мусорного трафика
                ...(xmuxConfig.enableJunkTraffic && {
                    junkTraffic: {
                        enabled: true,
                        percent: xmuxConfig.junkTrafficPercent,
                        minSize: xmuxConfig.junkMinSize,
                        maxSize: xmuxConfig.junkMaxSize,
                        interval: xmuxConfig.junkInterval,
                        types: xmuxConfig.junkTypes,
                    },
                }),
                // Добавляем настройки для изменения сигнатур
                ...(xmuxConfig.enablePacketSignatureMutation && {
                    signatureMutation: this.generatePacketSignatureMutationConfig(dpiConfig.packetSignatureMutation),
                }),
                // Добавляем обфускацию заголовков
                ...(xmuxConfig.enableHeaderObfuscation && {
                    headerObfuscation: {
                        enabled: true,
                    },
                }),
            };
        }

        // Применяем изменение сигнатур пакетов на уровне streamSettings
        if (dpiConfig.packetSignatureMutation?.enabled) {
            const signatureConfig = this.generatePacketSignatureMutationConfig(dpiConfig.packetSignatureMutation);
            if (!optimized.streamSettings.packetSignatureMutation) {
                optimized.streamSettings.packetSignatureMutation = signatureConfig;
            }
        }

        return optimized;
    }

    /**
     * Генерирует случайный путь для WebSocket
     */
    private generateRandomPath(): string {
        const paths = [
            '/ws',
            '/websocket',
            '/api',
            '/v1',
            '/graphql',
            '/socket.io',
            '/_next/webpack-hmr',
            '/live',
            '/stream',
        ];
        return paths[Math.floor(Math.random() * paths.length)];
    }

    /**
     * Генерирует мусорные данные для маскировки трафика
     */
    private generateJunkData(type: 'random' | 'http' | 'tls' | 'dns' | 'mixed', minSize: number, maxSize: number): string {
        const size = Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize;
        const buffer = Buffer.alloc(size);

        switch (type) {
            case 'http':
                // Генерируем HTTP-подобные данные
                const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
                const httpPaths = ['/api', '/v1', '/data', '/feed', '/update', '/sync', '/status'];
                const method = httpMethods[Math.floor(Math.random() * httpMethods.length)];
                const path = httpPaths[Math.floor(Math.random() * httpPaths.length)];
                const httpData = `${method} ${path} HTTP/1.1\r\nHost: ${this.REALITY_DOMAINS[Math.floor(Math.random() * this.REALITY_DOMAINS.length)]}\r\n\r\n`;
                Buffer.from(httpData).copy(buffer, 0);
                // Заполняем остаток случайными данными
                for (let i = httpData.length; i < size; i++) {
                    buffer[i] = Math.floor(Math.random() * 256);
                }
                break;

            case 'tls':
                // Генерируем TLS-подобные данные (заголовки TLS)
                const tlsHeader = Buffer.from([0x16, 0x03, 0x03]); // TLS handshake
                tlsHeader.copy(buffer, 0);
                // Заполняем остаток случайными данными
                for (let i = 3; i < size; i++) {
                    buffer[i] = Math.floor(Math.random() * 256);
                }
                break;

            case 'dns':
                // Генерируем DNS-подобные данные
                const dnsHeader = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x01]);
                dnsHeader.copy(buffer, 0);
                // Заполняем остаток случайными данными
                for (let i = 6; i < size; i++) {
                    buffer[i] = Math.floor(Math.random() * 256);
                }
                break;

            case 'mixed':
                // Смешанный тип - случайно выбираем один из типов
                const types: ('http' | 'tls' | 'dns' | 'random')[] = ['http', 'tls', 'dns', 'random'];
                return this.generateJunkData(types[Math.floor(Math.random() * types.length)], minSize, maxSize);

            case 'random':
            default:
                // Полностью случайные данные
                for (let i = 0; i < size; i++) {
                    buffer[i] = Math.floor(Math.random() * 256);
                }
                break;
        }

        return buffer.toString('base64');
    }

    /**
     * Генерирует измененную сигнатуру пакета
     */
    private mutatePacketSignature(originalSignature: string, method: 'randomize' | 'rotate' | 'scramble' | 'encrypt'): string {
        const buffer = Buffer.from(originalSignature, 'utf8');

        switch (method) {
            case 'randomize':
                // Случайно изменяем байты
                for (let i = 0; i < buffer.length; i++) {
                    if (Math.random() > 0.5) {
                        buffer[i] = Math.floor(Math.random() * 256);
                    }
                }
                break;

            case 'rotate':
                // Циклический сдвиг
                const shift = Math.floor(Math.random() * buffer.length);
                const rotated = Buffer.alloc(buffer.length);
                for (let i = 0; i < buffer.length; i++) {
                    rotated[i] = buffer[(i + shift) % buffer.length];
                }
                return rotated.toString('base64');

            case 'scramble':
                // Перемешиваем байты
                const scrambled = Buffer.from(buffer);
                for (let i = scrambled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [scrambled[i], scrambled[j]] = [scrambled[j], scrambled[i]];
                }
                return scrambled.toString('base64');

            case 'encrypt':
                // Простое XOR шифрование с случайным ключом
                const key = Math.floor(Math.random() * 256);
                for (let i = 0; i < buffer.length; i++) {
                    buffer[i] ^= key;
                }
                break;
        }

        return buffer.toString('base64');
    }

    /**
     * Генерирует XHTTP конфигурацию с максимальной маскировкой от DPI
     * XHTTP маскирует трафик под обычные HTTP запросы
     */
    public generateXHTTPConfig(config?: Partial<IXHTTPConfig>): IXHTTPConfig {
        const randomDomain = this.REALITY_DOMAINS[Math.floor(Math.random() * this.REALITY_DOMAINS.length)];
        const randomPath = this.generateRandomPath();

        // Генерируем реалистичные HTTP заголовки
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        ];

        const defaultConfig: IXHTTPConfig = {
            host: [randomDomain],
            path: randomPath,
            method: 'GET',
            headers: {
                'User-Agent': [userAgents[Math.floor(Math.random() * userAgents.length)]],
                'Accept': ['*/*', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
                'Accept-Language': ['en-US,en;q=0.9', 'ru-RU,ru;q=0.8'],
                'Accept-Encoding': ['gzip, deflate, br'],
                'Connection': ['keep-alive'],
                'Upgrade-Insecure-Requests': ['1'],
                'Cache-Control': ['no-cache'],
                'Pragma': ['no-cache'],
                'Referer': [`https://${randomDomain}/`],
            },
            enableJunkTraffic: config?.enableJunkTraffic ?? true,
            junkTrafficPercent: config?.junkTrafficPercent ?? 30, // 30% мусорного трафика
            junkMinSize: config?.junkMinSize ?? 64,
            junkMaxSize: config?.junkMaxSize ?? 1024,
            enablePacketSignatureMutation: config?.enablePacketSignatureMutation ?? true,
            signatureMutationInterval: config?.signatureMutationInterval ?? 5000, // Каждые 5 секунд
        };

        return {
            ...defaultConfig,
            ...config,
        };
    }

    /**
     * Генерирует XMUX конфигурацию с мусорным трафиком и изменением сигнатур
     * XMUX мультиплексирует соединения и может генерировать мусорный трафик
     */
    public generateXMUXConfig(config?: Partial<IXMUXConfig>): IXMUXConfig {
        const defaultConfig: IXMUXConfig = {
            enabled: true,
            concurrency: config?.concurrency ?? 16, // Максимум 16 одновременных соединений
            enableJunkTraffic: config?.enableJunkTraffic ?? true,
            junkTrafficPercent: config?.junkTrafficPercent ?? 40, // 40% мусорного трафика
            junkMinSize: config?.junkMinSize ?? 128,
            junkMaxSize: config?.junkMaxSize ?? 2048,
            junkInterval: config?.junkInterval ?? 3000, // Каждые 3 секунды
            junkTypes: config?.junkTypes ?? ['mixed'], // Смешанные типы мусорных данных
            enablePacketSignatureMutation: config?.enablePacketSignatureMutation ?? true,
            signatureMutationInterval: config?.signatureMutationInterval ?? 3000, // Каждые 3 секунды
            enableHeaderObfuscation: config?.enableHeaderObfuscation ?? true,
        };

        return {
            ...defaultConfig,
            ...config,
        };
    }

    /**
     * Генерирует конфигурацию для изменения сигнатур пакетов
     */
    public generatePacketSignatureMutationConfig(
        config?: Partial<IPacketSignatureMutation>,
    ): IPacketSignatureMutation {
        const defaultConfig: IPacketSignatureMutation = {
            enabled: true,
            methods: ['randomize', 'rotate', 'scramble'], // Используем несколько методов
            interval: config?.interval ?? 3000, // Каждые 3 секунды
            minLength: config?.minLength ?? 16,
            maxLength: config?.maxLength ?? 64,
        };

        return {
            ...defaultConfig,
            ...config,
        };
    }
}

