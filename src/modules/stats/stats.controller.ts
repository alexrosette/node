import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common';

import { HttpExceptionFilter } from '@common/exception';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';
import { errorHandler } from '@common/helpers';
import { PanelId } from '@common/multi-panel';
import { STATS_CONTROLLER, STATS_ROUTES } from '@libs/contracts/api/controllers/stats';

import {
    GetAllInboundsStatsRequestDto,
    GetAllInboundsStatsResponseDto,
    GetAllOutboundsStatsRequestDto,
    GetAllOutboundsStatsResponseDto,
    GetCombinedStatsRequestDto,
    GetCombinedStatsResponseDto,
    GetGeocheckRequestDto,
    GetGeocheckResponseDto,
    GetInboundStatsRequestDto,
    GetInboundStatsResponseDto,
    GetOutboundStatsRequestDto,
    GetOutboundStatsResponseDto,
    GetSystemStatsResponseDto,
    GetUserOnlineStatusRequestDto,
    GetUserOnlineStatusResponseDto,
    GetUsersIpListResponseDto,
    GetUsersStatsRequestDto,
    GetUsersStatsResponseDto,
} from './dto';
import { GetUserIpListRequestDto, GetUserIpListResponseDto } from './dto/get-user-ip-list.dto';
import { GeocheckService } from './geocheck.service';
import { StatsService } from './stats.service';

@UseFilters(HttpExceptionFilter)
@UseGuards(JwtDefaultGuard)
@Controller(STATS_CONTROLLER)
export class StatsController {
    constructor(
        private readonly statsService: StatsService,
        private readonly geocheckService: GeocheckService,
    ) {}

    @Post(STATS_ROUTES.GET_USER_ONLINE_STATUS)
    public async getUserOnlineStatus(
        @Body() body: GetUserOnlineStatusRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetUserOnlineStatusResponseDto> {
        const response = await this.statsService.getUserOnlineStatus(body, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_GEOCHECK)
    public async getGeocheck(@Body() body: GetGeocheckRequestDto): Promise<GetGeocheckResponseDto> {
        const response = await this.geocheckService.getGeocheck(body);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Get(STATS_ROUTES.GET_SYSTEM_STATS)
    public async getSystemStats(@PanelId() panelId: number): Promise<GetSystemStatsResponseDto> {
        const response = await this.statsService.getSystemStats(panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_USERS_STATS)
    public async getUsersStats(
        @Body() body: GetUsersStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetUsersStatsResponseDto> {
        const { reset } = body;
        const response = await this.statsService.getUsersStats(reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_INBOUND_STATS)
    public async getInboundStats(
        @Body() body: GetInboundStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetInboundStatsResponseDto> {
        const { tag, reset } = body;
        const response = await this.statsService.getInboundStats(tag, reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_OUTBOUND_STATS)
    public async getOutboundStats(
        @Body() body: GetOutboundStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetOutboundStatsResponseDto> {
        const { tag, reset } = body;
        const response = await this.statsService.getOutboundStats(tag, reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_ALL_INBOUNDS_STATS)
    public async getAllInboundsStats(
        @Body() body: GetAllInboundsStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetAllInboundsStatsResponseDto> {
        const { reset } = body;
        const response = await this.statsService.getAllInboundsStats(reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_ALL_OUTBOUNDS_STATS)
    public async getAllOutboundsStats(
        @Body() body: GetAllOutboundsStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetAllOutboundsStatsResponseDto> {
        const { reset } = body;
        const response = await this.statsService.getAllOutboundsStats(reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_COMBINED_STATS)
    public async getCombinedStats(
        @Body() body: GetCombinedStatsRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetCombinedStatsResponseDto> {
        const { reset } = body;
        const response = await this.statsService.getCombinedStats(reset, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Post(STATS_ROUTES.GET_USER_IP_LIST)
    public async getUserIpList(
        @Body() body: GetUserIpListRequestDto,
        @PanelId() panelId: number,
    ): Promise<GetUserIpListResponseDto> {
        const { userId } = body;
        const response = await this.statsService.getUserIpList(userId, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Get(STATS_ROUTES.GET_USERS_IP_LIST)
    public async getUsersIpList(@PanelId() panelId: number): Promise<GetUsersIpListResponseDto> {
        const response = await this.statsService.getUsersIpList(panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }
}
