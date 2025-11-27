import {
    XRAY_DEFAULT_API_MODEL,
    XRAY_DEFAULT_POLICY_MODEL,
    XRAY_DEFAULT_STATS_MODEL,
    // XRAY_ROUTING_RULES_MODEL,
} from '@libs/contracts/constants/xray';

import { IPolicyConfig } from './interfaces';
import { DPIOptimizer } from './dpi-optimization';
import { IDPIOptimizedConfig } from './interfaces/dpi-resistant.interfaces';

/**
 * Генерирует конфигурацию API для Xray с поддержкой DPI-resistant оптимизаций
 * @param config - Базовая конфигурация Xray
 * @param dpiConfig - Опциональная конфигурация для обхода DPI
 * @returns Оптимизированная конфигурация Xray
 */
export const generateApiConfig = (
    config: Record<string, unknown>,
    dpiConfig?: IDPIOptimizedConfig,
): Record<string, unknown> => {
    // const routing = config.routing as undefined | { rules?: unknown[] };
    const policyConfig = config.policy as undefined | IPolicyConfig;

    // Используем DPI оптимизатор, если включена оптимизация
    const dpiOptimizer = new DPIOptimizer();
    const useDPIOptimization = dpiConfig?.enableDPIOptimization ?? false;

    // Генерируем базовую политику
    let builtPolicy: IPolicyConfig;

    if (useDPIOptimization && dpiConfig?.policy) {
        // Используем оптимизированную политику для обхода DPI
        const optimizedPolicy = dpiOptimizer.generateOptimizedPolicy();
        builtPolicy = {
            levels: {
                '0': {
                    ...optimizedPolicy.levels['0'],
                    ...(policyConfig?.levels?.['0'] || {}),
                    // Сохраняем настройки статистики из дефолтной модели
                    statsUserUplink: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserUplink,
                    statsUserDownlink: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserDownlink,
                    statsUserOnline: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserOnline,
                },
            },
            system: {
                ...optimizedPolicy.system,
                ...XRAY_DEFAULT_POLICY_MODEL.policy.system,
            },
        };
    } else {
        // Используем стандартную политику
        builtPolicy = {
            levels: {
                '0': {
                    ...(policyConfig?.levels?.['0'] || {}),
                    statsUserUplink: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserUplink,
                    statsUserDownlink: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserDownlink,
                    statsUserOnline: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserOnline,
                },
            },
            system: XRAY_DEFAULT_POLICY_MODEL.policy.system,
        };
    }

    // Генерируем базовую конфигурацию
    let generatedConfig: Record<string, unknown> = {
        ...config,
        ...XRAY_DEFAULT_STATS_MODEL,
        ...XRAY_DEFAULT_API_MODEL,
        policy: builtPolicy,
        // routing: {
        //     ...(routing || {}),
        //     rules: [XRAY_ROUTING_RULES_MODEL, ...(routing?.rules || [])],
        // },
        // inbounds: [
        //     XRAY_API_INBOUND_MODEL,
        //     ...(Array.isArray(config.inbounds) ? config.inbounds : []),
        // ],
    };

    // Применяем DPI оптимизации, если они включены
    if (useDPIOptimization && dpiConfig) {
        generatedConfig = dpiOptimizer.applyDPIOptimizations(generatedConfig, dpiConfig);
    }

    return generatedConfig;
};
