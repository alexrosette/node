import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { ownUsername, toXrayEmail } from '@common/multi-panel';
import { fail, ok, TResult } from '@common/types';
import { getSystemStats } from '@common/utils/get-system-stats';
import { ERRORS } from '@libs/contracts/constants';

import { GetTorrentBlockerReportsCountQuery } from '../_plugin/queries/get-torrent-blocker-reports-count';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { IGetUserOnlineStatusRequest } from './interfaces';
import {
    GetAllInboundsStatsResponseModel,
    GetAllOutboundsStatsResponseModel,
    GetCombinedStatsResponseModel,
    GetInboundStatsResponseModel,
    GetOutboundStatsResponseModel,
    GetSystemStatsResponseModel,
    GetUserIpListResponseModel,
    GetUserOnlineStatusResponseModel,
    GetUsersIpListResponseModel,
    GetUsersStatsResponseModel,
} from './models';
import { StatsLedgerService } from './stats-ledger.service';

@Injectable()
export class StatsService {
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        private readonly queryBus: QueryBus,
        private readonly ledger: StatsLedgerService,
    ) {}
    private readonly logger = new Logger(StatsService.name);

    public async getUserOnlineStatus(
        body: IGetUserOnlineStatusRequest,
        panelId: number,
    ): Promise<TResult<GetUserOnlineStatusResponseModel>> {
        try {
            const response = await this.xtlsSdk.stats.getUserOnlineStatus(
                toXrayEmail(panelId, body.username),
            );

            if (response.isOk && response.data) {
                return ok(new GetUserOnlineStatusResponseModel(response.data.online));
            }

            return ok(new GetUserOnlineStatusResponseModel(false));
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: true,
                response: new GetUserOnlineStatusResponseModel(false),
            };
        }
    }

    public async getSystemStats(panelId: number): Promise<TResult<GetSystemStatsResponseModel>> {
        try {
            const response = await this.xtlsSdk.stats.getSysStats();

            if (!response.isOk || !response.data) {
                this.logger.warn(response);
                return fail(ERRORS.FAILED_TO_GET_SYSTEM_STATS);
            }

            const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
            const systemStats = getSystemStats();
            const reportsCount = await this.queryBus.execute(
                new GetTorrentBlockerReportsCountQuery(panelId),
            );

            return {
                isOk: true,
                response: new GetSystemStatsResponseModel(
                    response.data,
                    {
                        torrentBlocker: {
                            reportsCount,
                        },
                    },
                    {
                        ...systemStats,
                        interface: interfaceStats,
                    },
                ),
            };
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: false,
                ...ERRORS.FAILED_TO_GET_SYSTEM_STATS,
            };
        }
    }

    public async getUsersStats(
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetUsersStatsResponseModel>> {
        try {
            const users = await this.ledger.takeUsersStats(panelId, reset);

            if (!users) {
                return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
            }

            return ok(
                new GetUsersStatsResponseModel(
                    users.filter((user) => user.uplink !== 0 || user.downlink !== 0),
                ),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
        }
    }

    public async getInboundStats(
        tag: string,
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetInboundStatsResponseModel>> {
        try {
            const inbound = await this.ledger.takeInboundStats(panelId, tag, reset);

            if (!inbound) {
                return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
            }

            return ok(new GetInboundStatsResponseModel(inbound));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
        }
    }

    public async getOutboundStats(
        tag: string,
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetOutboundStatsResponseModel>> {
        try {
            const outbound = await this.ledger.takeOutboundStats(panelId, tag, reset);

            if (!outbound) {
                return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
            }

            return ok(new GetOutboundStatsResponseModel(outbound));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
        }
    }

    public async getAllInboundsStats(
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetAllInboundsStatsResponseModel>> {
        try {
            const inbounds = await this.ledger.takeInboundsStats(panelId, reset);

            if (!inbounds) {
                return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
            }

            return ok(new GetAllInboundsStatsResponseModel(inbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getAllOutboundsStats(
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetAllOutboundsStatsResponseModel>> {
        try {
            const outbounds = await this.ledger.takeOutboundsStats(panelId, reset);

            if (!outbounds) {
                return fail(ERRORS.FAILED_TO_GET_OUTBOUNDS_STATS);
            }

            return ok(new GetAllOutboundsStatsResponseModel(outbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getCombinedStats(
        reset: boolean,
        panelId: number,
    ): Promise<TResult<GetCombinedStatsResponseModel>> {
        try {
            const inbounds = await this.ledger.takeInboundsStats(panelId, reset);
            const outbounds = await this.ledger.takeOutboundsStats(panelId, reset);

            if (!inbounds || !outbounds) {
                return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
            }

            return ok(new GetCombinedStatsResponseModel(inbounds, outbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
        }
    }

    public async getUserIpList(
        userId: string,
        panelId: number,
    ): Promise<TResult<GetUserIpListResponseModel>> {
        try {
            const userIps = await this.xtlsSdk.stats.rawClient.getStatsOnlineIpList({
                name: `user>>>${toXrayEmail(panelId, userId)}>>>online`,
                reset: true,
            });

            const ips = Object.entries(userIps.ips).map(([ip, timestamp]) => ({
                ip,
                lastSeen: new Date(timestamp * 1000),
            }));

            return ok(new GetUserIpListResponseModel(ips));
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 5) {
                return ok(new GetUserIpListResponseModel([]));
            }

            this.logger.error(error);
            return ok(new GetUserIpListResponseModel([]));
        }
    }

    public async getUsersIpList(panelId: number): Promise<TResult<GetUsersIpListResponseModel>> {
        try {
            const response = await this.xtlsSdk.stats.getUsersStats(false, false);

            if (!response.isOk || !response.data || !response.data.users) {
                this.logger.error(response);
                return ok(new GetUsersIpListResponseModel([]));
            }

            const users = response.data.users.flatMap((user) => {
                const username = ownUsername(panelId, user.userId);

                return username === null ? [] : [{ userId: username, ips: user.ips }];
            });

            return ok(new GetUsersIpListResponseModel(users));
        } catch (error) {
            this.logger.error(error);
            return ok(new GetUsersIpListResponseModel([]));
        }
    }
}
