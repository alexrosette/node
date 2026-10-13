import ems from 'enhanced-ms';
import { hasCapNetAdmin } from 'sockdestroy';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';
import { ISdkResponse } from '@remnawave/xtls-sdk/build/src/common/types';
import {
    RemoveUserResponseModel as RemoveUserResponseModelFromSdk,
    AddUserResponseModel as AddUserResponseModelFromSdk,
} from '@remnawave/xtls-sdk/build/src/handler/models';

import { toXrayEmail } from '@common/multi-panel';
import { fail, ok, TResult } from '@common/types';
import { withCoreLock } from '@common/utils/core-lock';
import { buildXrayClient } from '@common/utils/xray-clients';
import { ERRORS } from '@libs/contracts/constants/errors';

import { DropConnectionsEvent } from '../_plugin/events/drop-connections';
import { InternalService } from '../internal/internal.service';
import {
    AddUserRequestDto,
    AddUsersRequestDto,
    DropIpsRequestDto,
    DropUsersConnectionsRequestDto,
    RemoveUserRequestDto,
    RemoveUsersRequestDto,
} from './dtos';
import { AddUserResponseModel, RemoveUserResponseModel, GenericResponseModel } from './models';

@Injectable()
export class HandlerService implements OnModuleInit {
    private readonly logger = new Logger(HandlerService.name);
    private capNetAdminAvailable = false;

    constructor(
        @InjectXtls() private readonly xtlsApi: XtlsApi,
        private readonly internalService: InternalService,
        private readonly eventBus: EventBus,
    ) {}

    public async onModuleInit(): Promise<void> {
        try {
            if (!hasCapNetAdmin()) {
                this.capNetAdminAvailable = false;
                this.logger.warn('CAP_NET_ADMIN is not available.');
            } else {
                this.capNetAdminAvailable = true;
                this.logger.log('[OK] CAP_NET_ADMIN is available');
            }
        } catch (error: unknown) {
            this.logger.error(error);
        }
    }

    public async addUser(
        data: AddUserRequestDto,
        panelId: number,
    ): Promise<TResult<AddUserResponseModel>> {
        return withCoreLock(() => this.addUserUnsafe(data, panelId));
    }

    private async addUserUnsafe(
        data: AddUserRequestDto,
        panelId: number,
    ): Promise<TResult<AddUserResponseModel>> {
        try {
            const { data: requestData, hashData } = data;
            const response: Array<ISdkResponse<AddUserResponseModelFromSdk>> = [];
            const userId = toXrayEmail(panelId, requestData[0].username);
            let userIps: string[] | null = null;

            for (const item of requestData) {
                this.internalService.addXtlsConfigInbound(item.tag);
            }

            if (hashData.prevVlessUuid) {
                userIps = await this.getUserIps(userId);
            }

            for (const tag of this.internalService.getXtlsConfigInbounds()) {
                this.logger.debug(`Removing user: ${userId} from tag: ${tag}`);

                await this.xtlsApi.handler.removeUser(tag, userId);

                await this.internalService.removeUserFromInbound(
                    panelId,
                    tag,
                    hashData.prevVlessUuid ?? hashData.vlessUuid,
                    userId,
                );
            }

            if (userIps && hashData.prevVlessUuid) {
                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            for (const item of requestData) {
                let tempRes: ISdkResponse<AddUserResponseModelFromSdk>;

                const username = toXrayEmail(panelId, item.username);

                this.logger.debug(`Adding user: ${username} with type: ${item.type}`);

                switch (item.type) {
                    case 'trojan':
                        tempRes = await this.xtlsApi.handler.addTrojanUser({
                            tag: item.tag,
                            username,
                            password: item.password,
                            level: 0,
                        });
                        break;
                    case 'vless':
                        tempRes = await this.xtlsApi.handler.addVlessUser({
                            tag: item.tag,
                            username,
                            uuid: item.uuid,
                            flow: item.flow,
                            level: 0,
                        });
                        break;
                    case 'shadowsocks':
                        tempRes = await this.xtlsApi.handler.addShadowsocksUser({
                            tag: item.tag,
                            username,
                            password: item.password,
                            cipherType: item.cipherType,
                            ivCheck: false,
                            level: 0,
                        });
                        break;
                    case 'shadowsocks22':
                        tempRes = await this.xtlsApi.handler.addShadowsocks2022User({
                            tag: item.tag,
                            username,
                            key: item.password,
                            level: 0,
                        });
                        break;
                    case 'hysteria':
                        tempRes = await this.xtlsApi.handler.addHysteriaUser({
                            tag: item.tag,
                            username,
                            uuid: item.password,
                            level: 0,
                        });
                        break;
                }

                if (tempRes.isOk) {
                    await this.internalService.addUserToInbound(
                        panelId,
                        item.tag,
                        hashData.vlessUuid,
                        buildXrayClient({
                            type: item.type,
                            email: username,
                            hashUuid: hashData.vlessUuid,
                            vlessUuid: item.type === 'vless' ? item.uuid : hashData.vlessUuid,
                            password: item.type === 'vless' ? undefined : item.password,
                            cipherType: item.type === 'shadowsocks' ? item.cipherType : undefined,
                            inbound: this.internalService.getTemplateInbound(item.tag),
                        }),
                    );
                }

                response.push(tempRes);
            }

            if (response.every((res) => !res.isOk)) {
                this.logger.error('Error adding users: ' + JSON.stringify(response, null, 2));
                return ok(
                    new AddUserResponseModel(
                        false,
                        response.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new AddUserResponseModel(true, null));
        } catch (error) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        }
    }

    public async removeUser(
        data: RemoveUserRequestDto,
        panelId: number,
    ): Promise<TResult<RemoveUserResponseModel>> {
        return withCoreLock(() => this.removeUserUnsafe(data, panelId));
    }

    private async removeUserUnsafe(
        data: RemoveUserRequestDto,
        panelId: number,
    ): Promise<TResult<RemoveUserResponseModel>> {
        try {
            const { hashData } = data;
            const username = toXrayEmail(panelId, data.username);
            const response: Array<ISdkResponse<RemoveUserResponseModelFromSdk>> = [];

            const inboundTags = this.internalService.getXtlsConfigInbounds();

            if (inboundTags.size === 0) {
                return ok(new RemoveUserResponseModel(true, null));
            }

            const userIps = await this.getUserIps(username);

            for (const tag of inboundTags) {
                this.logger.debug(`Removing user: ${username} from tag: ${tag}`);

                const tempRes = await this.xtlsApi.handler.removeUser(tag, username);

                await this.internalService.removeUserFromInbound(
                    panelId,
                    tag,
                    hashData.vlessUuid,
                    username,
                );
                response.push(tempRes);
            }

            this.eventBus.publish(new DropConnectionsEvent(userIps));

            if (response.every((res) => !res.isOk)) {
                this.logger.error(JSON.stringify(response, null, 2));
                return ok(
                    new RemoveUserResponseModel(
                        false,
                        response.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new RemoveUserResponseModel(true, null));
        } catch (error: unknown) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        }
    }

    public async addUsers(
        data: AddUsersRequestDto,
        panelId: number,
    ): Promise<TResult<AddUserResponseModel>> {
        return withCoreLock(() => this.addUsersUnsafe(data, panelId));
    }

    private async addUsersUnsafe(
        data: AddUsersRequestDto,
        panelId: number,
    ): Promise<TResult<AddUserResponseModel>> {
        const tm = performance.now();
        try {
            const { affectedInboundTags, users } = data;

            for (const tag of affectedInboundTags) {
                this.internalService.addXtlsConfigInbound(tag);
            }

            this.logger.log(
                `[panel #${panelId}] Adding ${users.length} users to inbounds: ${affectedInboundTags.join(', ')}`,
            );

            for (const user of users) {
                const username = toXrayEmail(panelId, user.userData.userId);

                for (const tag of this.internalService.getXtlsConfigInbounds()) {
                    await this.xtlsApi.handler.removeUser(tag, username);

                    await this.internalService.removeUserFromInbound(
                        panelId,
                        tag,
                        user.userData.hashUuid,
                        username,
                    );
                }

                for (const item of user.inboundData) {
                    let tempRes: ISdkResponse<AddUserResponseModelFromSdk> | null = null;
                    let password: string | undefined;

                    switch (item.type) {
                        case 'trojan':
                            password = user.userData.trojanPassword;
                            tempRes = await this.xtlsApi.handler.addTrojanUser({
                                tag: item.tag,
                                username,
                                password,
                                level: 0,
                            });
                            break;
                        case 'vless':
                            tempRes = await this.xtlsApi.handler.addVlessUser({
                                tag: item.tag,
                                username,
                                uuid: user.userData.vlessUuid,
                                flow: item.flow,
                                level: 0,
                            });
                            break;
                        case 'shadowsocks':
                            password = user.userData.ssPassword;
                            tempRes = await this.xtlsApi.handler.addShadowsocksUser({
                                tag: item.tag,
                                username,
                                password,
                                cipherType: 0,
                                ivCheck: false,
                                level: 0,
                            });
                            break;
                        case 'shadowsocks22':
                            password = Buffer.from(user.userData.ssPassword).toString('base64');
                            tempRes = await this.xtlsApi.handler.addShadowsocks2022User({
                                tag: item.tag,
                                username,
                                key: password,
                                level: 0,
                            });
                            break;
                        case 'hysteria':
                            password = user.userData.vlessUuid;
                            tempRes = await this.xtlsApi.handler.addHysteriaUser({
                                tag: item.tag,
                                username,
                                uuid: password,
                                level: 0,
                            });
                            break;
                        default:
                            break;
                    }

                    if (tempRes?.isOk) {
                        await this.internalService.addUserToInbound(
                            panelId,
                            item.tag,
                            user.userData.vlessUuid,
                            buildXrayClient({
                                type: item.type,
                                email: username,
                                hashUuid: user.userData.vlessUuid,
                                vlessUuid: user.userData.vlessUuid,
                                password,
                                inbound: this.internalService.getTemplateInbound(item.tag),
                            }),
                        );
                    }
                }
            }

            return ok(new AddUserResponseModel(true, null));
        } catch (error) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        } finally {
            this.logger.log(
                'Users addition took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );
        }
    }

    public async removeUsers(
        data: RemoveUsersRequestDto,
        panelId: number,
    ): Promise<TResult<RemoveUserResponseModel>> {
        return withCoreLock(() => this.removeUsersUnsafe(data, panelId));
    }

    private async removeUsersUnsafe(
        data: RemoveUsersRequestDto,
        panelId: number,
    ): Promise<TResult<RemoveUserResponseModel>> {
        const tm = performance.now();
        try {
            const inboundTags = this.internalService.getXtlsConfigInbounds();

            if (inboundTags.size === 0) {
                return ok(new RemoveUserResponseModel(true, null));
            }

            this.logger.log(
                `[panel #${panelId}] Removing ${data.users.length} users from inbounds: ${Array.from(inboundTags).join(', ')}`,
            );

            const removeUsersResponse: Array<ISdkResponse<RemoveUserResponseModelFromSdk>> = [];

            for (const user of data.users) {
                const { hashUuid } = user;
                const userId = toXrayEmail(panelId, user.userId);

                const userIps = await this.getUserIps(userId);

                for (const tag of inboundTags) {
                    this.logger.debug(`Removing user: ${userId} from tag: ${tag}`);

                    const tempRes = await this.xtlsApi.handler.removeUser(tag, userId);

                    await this.internalService.removeUserFromInbound(
                        panelId,
                        tag,
                        hashUuid,
                        userId,
                    );
                    removeUsersResponse.push(tempRes);
                }

                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            if (removeUsersResponse.every((res) => !res.isOk)) {
                this.logger.error(JSON.stringify(removeUsersResponse, null, 2));
                return ok(
                    new RemoveUserResponseModel(
                        false,
                        removeUsersResponse.find((res) => !res.isOk)?.message ?? null,
                    ),
                );
            }

            return ok(new RemoveUserResponseModel(true, null));
        } catch (error: unknown) {
            this.logger.error(error);
            let message = '';
            if (error instanceof Error) {
                message = error.message;
            }
            return fail({ code: ERRORS.INTERNAL_SERVER_ERROR.code, message });
        } finally {
            this.logger.log(
                'Users removal took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );
        }
    }

    public async dropUsersConnections(
        data: DropUsersConnectionsRequestDto,
        panelId: number,
    ): Promise<TResult<GenericResponseModel>> {
        try {
            const { userIds } = data;

            for (const userId of userIds) {
                const userIps = await this.getUserIps(toXrayEmail(panelId, userId));
                this.eventBus.publish(new DropConnectionsEvent(userIps));
            }

            return ok(new GenericResponseModel(true));
        } catch (error) {
            this.logger.error(error);
            return ok(new GenericResponseModel(false));
        }
    }

    public async dropIps(data: DropIpsRequestDto): Promise<TResult<GenericResponseModel>> {
        try {
            const { ips } = data;

            this.eventBus.publish(new DropConnectionsEvent(ips));

            return ok(new GenericResponseModel(true));
        } catch (error) {
            this.logger.error(error);
            return ok(new GenericResponseModel(false));
        }
    }

    private async getUserIps(userId: string): Promise<string[] | null> {
        try {
            if (!this.capNetAdminAvailable) {
                return null;
            }

            const userIps = await this.xtlsApi.stats.rawClient.getStatsOnlineIpList({
                name: `user>>>${userId}>>>online`,
                reset: true,
            });

            const ips = Object.keys(userIps.ips);

            return ips;
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 5) {
                return null;
            }

            this.logger.error(`Failed to get user IPs for user ${userId}: ${error}`);
            return null;
        }
    }

    public async removeOutbound(tag: string): Promise<void> {
        try {
            await this.xtlsApi.handler.rawClient.removeOutbound({
                tag,
            });

            return;
        } catch (error) {
            this.logger.error(error);
            return;
        }
    }
}
