/**
 * Интерфейсы для DPI-resistant конфигурации Xray
 * Используются для обхода Deep Packet Inspection систем
 */

export interface ITLSConfig {
    /**
     * Минимальная версия TLS (1.2 или 1.3)
     * Рекомендуется 1.3 для лучшей безопасности
     */
    minVersion?: '1.2' | '1.3';
    /**
     * Максимальная версия TLS
     */
    maxVersion?: '1.2' | '1.3';
    /**
     * Список поддерживаемых cipher suites
     * Имитирует реальные браузеры
     */
    cipherSuites?: string;
    /**
     * Fingerprint браузера для имитации
     * chrome, firefox, safari, edge, ios, android, randomized
     */
    fingerprint?: string;
    /**
     * Отключить проверку сертификата (только для тестирования)
     */
    rejectUnknownSni?: boolean;
    /**
     * Серверное имя для SNI
     */
    serverName?: string;
    /**
     * Список альтернативных имен сервера
     */
    alpn?: string[];
    /**
     * Отключить проверку сертификата
     */
    allowInsecure?: boolean;
}

export interface IRealityConfig {
    /**
     * Публичный ключ Reality
     */
    publicKey: string;
    /**
     * Короткий ID для Reality
     */
    shortId: string;
    /**
     * Серверное имя для маскировки
     */
    serverNames: string[];
    /**
     * Домены для маскировки (список популярных сайтов)
     */
    dest?: string;
    /**
     * Xver для проксирования
     */
    xver?: number;
    /**
     * Минимальная версия Xray для Reality
     */
    minClientVer?: string;
    /**
     * Максимальная версия клиента
     */
    maxClientVer?: string;
    /**
     * Максимальное время жизни
     */
    maxTimeDiff?: number;
}

export interface IWebSocketConfig {
    /**
     * Путь для WebSocket
     */
    path: string;
    /**
     * Заголовки для WebSocket
     */
    headers?: Record<string, string>;
    /**
     * Максимальное время простоя
     */
    maxEarlyData?: number;
    /**
     * Использовать ранние данные
     */
    useBrowserForwarding?: boolean;
    /**
     * Early data header name
     */
    earlyDataHeaderName?: string;
}

export interface IGRPCConfig {
    /**
     * Имя сервиса для gRPC
     */
    serviceName: string;
    /**
     * Мультиплексирование
     */
    multiMode?: boolean;
    /**
     * Имитация Google сервисов
     */
    idle_timeout?: number;
    /**
     * Health check timeout
     */
    health_check_timeout?: number;
    /**
     * Разрешить без TLS (не рекомендуется)
     */
    permit_without_stream?: boolean;
    /**
     * Начальный размер окна
     */
    initial_windows_size?: number;
}

export interface IHTTP2Config {
    /**
     * Хост для HTTP/2
     */
    host?: string[];
    /**
     * Путь для HTTP/2
     */
    path?: string;
    /**
     * Метод для HTTP/2
     */
    method?: string;
    /**
     * Заголовки для HTTP/2
     */
    headers?: Record<string, string[]>;
}

export interface IQUICConfig {
    /**
     * Безопасность для QUIC
     */
    security: 'none' | 'aes-128-gcm' | 'chacha20-poly1305';
    /**
     * Ключ для QUIC
     */
    key: string;
    /**
     * Тип заголовка
     */
    header?: {
        type: 'none' | 'srtp' | 'utp' | 'wechat-video' | 'dtls' | 'wireguard';
    };
}

export interface IXHTTPConfig {
    /**
     * Список хостов для маскировки
     */
    host?: string[];
    /**
     * Путь для HTTP запросов
     */
    path?: string;
    /**
     * Метод HTTP (GET, POST, PUT, etc.)
     */
    method?: string;
    /**
     * Заголовки HTTP для максимальной маскировки
     */
    headers?: Record<string, string[]>;
    /**
     * Включить генерацию мусорного трафика
     */
    enableJunkTraffic?: boolean;
    /**
     * Процент мусорного трафика (0-100)
     */
    junkTrafficPercent?: number;
    /**
     * Минимальный размер мусорного пакета (байты)
     */
    junkMinSize?: number;
    /**
     * Максимальный размер мусорного пакета (байты)
     */
    junkMaxSize?: number;
    /**
     * Изменение сигнатуры пакетов
     */
    enablePacketSignatureMutation?: boolean;
    /**
     * Частота изменения сигнатур (мс)
     */
    signatureMutationInterval?: number;
}

export interface IXMUXConfig {
    /**
     * Включить мультиплексирование
     */
    enabled?: boolean;
    /**
     * Максимальное количество соединений
     */
    concurrency?: number;
    /**
     * Включить генерацию мусорного трафика
     */
    enableJunkTraffic?: boolean;
    /**
     * Процент мусорного трафика (0-100)
     */
    junkTrafficPercent?: number;
    /**
     * Минимальный размер мусорного пакета (байты)
     */
    junkMinSize?: number;
    /**
     * Максимальный размер мусорного пакета (байты)
     */
    junkMaxSize?: number;
    /**
     * Интервал генерации мусорных пакетов (мс)
     */
    junkInterval?: number;
    /**
     * Типы мусорных данных для генерации
     */
    junkTypes?: ('random' | 'http' | 'tls' | 'dns' | 'mixed')[];
    /**
     * Изменение сигнатуры пакетов
     */
    enablePacketSignatureMutation?: boolean;
    /**
     * Частота изменения сигнатур (мс)
     */
    signatureMutationInterval?: number;
    /**
     * Включить обфускацию заголовков
     */
    enableHeaderObfuscation?: boolean;
}

export interface IPacketSignatureMutation {
    /**
     * Включить изменение сигнатур
     */
    enabled: boolean;
    /**
     * Методы изменения сигнатур
     */
    methods?: ('randomize' | 'rotate' | 'scramble' | 'encrypt')[];
    /**
     * Частота изменения (мс)
     */
    interval?: number;
    /**
     * Минимальная длина сигнатуры (байты)
     */
    minLength?: number;
    /**
     * Максимальная длина сигнатуры (байты)
     */
    maxLength?: number;
}

export interface IDPIOptimizedPolicy {
    /**
     * Таймаут рукопожатия (мс)
     * Уменьшен для быстрого установления соединения
     */
    handshake?: number;
    /**
     * Таймаут простоя соединения (мс)
     * Увеличен для поддержания соединений
     */
    connIdle?: number;
    /**
     * Таймаут только для uplink (мс)
     */
    uplinkOnly?: number;
    /**
     * Таймаут только для downlink (мс)
     */
    downlinkOnly?: number;
    /**
     * Размер буфера (байты)
     * Оптимизирован для лучшей производительности
     */
    bufferSize?: number;
}

export interface IDPIOptimizedConfig {
    /**
     * Использовать оптимизацию для обхода DPI
     */
    enableDPIOptimization?: boolean;
    /**
     * Предпочитаемый транспорт
     */
    preferredTransport?: 'reality' | 'websocket' | 'grpc' | 'h2' | 'quic' | 'tcp';
    /**
     * TLS конфигурация
     */
    tls?: ITLSConfig;
    /**
     * Reality конфигурация (если используется)
     */
    reality?: IRealityConfig;
    /**
     * WebSocket конфигурация
     */
    websocket?: IWebSocketConfig;
    /**
     * gRPC конфигурация
     */
    grpc?: IGRPCConfig;
    /**
     * HTTP/2 конфигурация
     */
    http2?: IHTTP2Config;
    /**
     * QUIC конфигурация
     */
    quic?: IQUICConfig;
    /**
     * XHTTP конфигурация (максимальная маскировка)
     */
    xhttp?: IXHTTPConfig;
    /**
     * XMUX конфигурация (мультиплексирование + мусорный трафик)
     */
    xmux?: IXMUXConfig;
    /**
     * Изменение сигнатур пакетов
     */
    packetSignatureMutation?: IPacketSignatureMutation;
    /**
     * Оптимизированные policy настройки
     */
    policy?: IDPIOptimizedPolicy;
}

