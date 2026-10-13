import { XtlsApi } from '@remnawave/xtls-sdk';
import { CipherType } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/shadowsocks/config';

type TClient = Record<string, unknown>;
type TInbound = {
    protocol?: string;
    settings?: Record<string, unknown>;
    [key: string]: unknown;
};

const SS2022_PREFIX = '2022-';
const DEFAULT_SS_METHOD = 'chacha20-ietf-poly1305';

function getInboundMethod(inbound: TInbound | undefined): string | undefined {
    const method = inbound?.settings?.method;

    return typeof method === 'string' ? method : undefined;
}

function isSs2022Method(method: string | undefined): boolean {
    return !!method && method.startsWith(SS2022_PREFIX);
}

function cipherTypeFromMethod(method: string | undefined): CipherType {
    switch (method) {
        case 'aes-128-gcm':
            return CipherType.AES_128_GCM;
        case 'aes-256-gcm':
            return CipherType.AES_256_GCM;
        case 'xchacha20-ietf-poly1305':
        case 'xchacha20-poly1305':
            return CipherType.XCHACHA20_POLY1305;
        case 'chacha20-ietf-poly1305':
        case 'chacha20-poly1305':
        default:
            return CipherType.CHACHA20_POLY1305;
    }
}

function methodFromCipherType(cipherType: number | undefined): string {
    switch (cipherType) {
        case CipherType.AES_128_GCM:
            return 'aes-128-gcm';
        case CipherType.AES_256_GCM:
            return 'aes-256-gcm';
        case CipherType.XCHACHA20_POLY1305:
            return 'xchacha20-ietf-poly1305';
        default:
            return DEFAULT_SS_METHOD;
    }
}

/**
 * Builds a config client object in the same shape the panel uses when it renders
 * the Xray config, so a user added through the API ends up identical in the
 * merged config after a restart.
 */
export function buildXrayClient(args: {
    type: 'hysteria' | 'shadowsocks' | 'shadowsocks22' | 'trojan' | 'vless';
    email: string;
    hashUuid: string;
    vlessUuid?: string;
    password?: string;
    cipherType?: number;
    inbound?: TInbound;
}): TClient {
    const { type, email, hashUuid, vlessUuid, password, cipherType, inbound } = args;

    switch (type) {
        case 'trojan':
            return { password, email, id: hashUuid };
        case 'vless':
            return { id: vlessUuid ?? hashUuid, email };
        case 'hysteria':
            return { id: hashUuid, auth: password ?? vlessUuid ?? hashUuid, email };
        case 'shadowsocks22':
            return { password, email, id: hashUuid };
        case 'shadowsocks': {
            const inboundMethod = getInboundMethod(inbound);

            if (isSs2022Method(inboundMethod)) {
                return { password, email, id: hashUuid };
            }

            return {
                password,
                method:
                    inboundMethod ??
                    (cipherType !== undefined
                        ? methodFromCipherType(cipherType)
                        : DEFAULT_SS_METHOD),
                email,
                id: hashUuid,
            };
        }
    }
}

/**
 * Adds a config client to a running inbound through the Xray API.
 */
export async function addXrayClientViaApi(
    xtlsApi: XtlsApi,
    tag: string,
    inbound: TInbound | undefined,
    client: TClient,
): Promise<{ isOk: boolean; message: null | string }> {
    const email = client.email;

    if (typeof email !== 'string') {
        return { isOk: false, message: 'Client has no email' };
    }

    if (!inbound) {
        return { isOk: false, message: `Inbound ${tag} not found in config` };
    }

    const str = (value: unknown): string => (typeof value === 'string' ? value : '');

    let res: { isOk: boolean; message?: string };

    switch (inbound.protocol) {
        case 'vless': {
            const rawFlow = str(client.flow) || str(inbound.settings?.flow);
            const flow = rawFlow === 'xtls-rprx-vision' ? 'xtls-rprx-vision' : '';

            res = await xtlsApi.handler.addVlessUser({
                tag,
                username: email,
                uuid: str(client.id),
                flow,
                level: 0,
            });
            break;
        }
        case 'trojan':
            res = await xtlsApi.handler.addTrojanUser({
                tag,
                username: email,
                password: str(client.password),
                level: 0,
            });
            break;
        case 'shadowsocks': {
            const method = str(client.method) || getInboundMethod(inbound);

            if (isSs2022Method(method)) {
                res = await xtlsApi.handler.addShadowsocks2022User({
                    tag,
                    username: email,
                    key: str(client.password),
                    level: 0,
                });
            } else {
                res = await xtlsApi.handler.addShadowsocksUser({
                    tag,
                    username: email,
                    password: str(client.password),
                    cipherType: cipherTypeFromMethod(method),
                    ivCheck: false,
                    level: 0,
                });
            }
            break;
        }
        case 'hysteria':
            res = await xtlsApi.handler.addHysteriaUser({
                tag,
                username: email,
                uuid: str(client.auth) || str(client.id),
                level: 0,
            });
            break;
        default:
            return {
                isOk: false,
                message: `Protocol ${String(inbound.protocol)} is not supported for hot user sync`,
            };
    }

    return { isOk: res.isOk, message: res.isOk ? null : (res.message ?? 'Unknown error') };
}
