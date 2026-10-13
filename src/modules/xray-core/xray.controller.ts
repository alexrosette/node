import { Body, Controller, Get, Ip, Logger, Post, UseFilters, UseGuards } from '@nestjs/common';

import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';
import { errorHandler } from '@common/helpers/error-handler.helper';
import { PanelId } from '@common/multi-panel';
import { XRAY_CONTROLLER, XRAY_ROUTES } from '@libs/contracts/api';

import {
    GetNodeHealthCheckResponseDto,
    StartXrayRequestDto,
    StartXrayResponseDto,
    StopXrayResponseDto,
} from './dtos/';
import { XrayService } from './xray.service';

@UseFilters(HttpExceptionFilter)
@UseGuards(JwtDefaultGuard)
@Controller(XRAY_CONTROLLER)
export class XrayController {
    private readonly logger = new Logger(XrayController.name);

    constructor(private readonly xrayService: XrayService) {}

    @Post(XRAY_ROUTES.START)
    public async startXray(
        @Body() body: StartXrayRequestDto,
        @Ip() ip: string,
        @PanelId() panelId: number,
    ): Promise<StartXrayResponseDto> {
        const response = await this.xrayService.startXray(body, ip, panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Get(XRAY_ROUTES.STOP)
    public async stopXray(@PanelId() panelId: number): Promise<StopXrayResponseDto> {
        this.logger.log(`Remnawave (panel #${panelId}) requested to stop Xray.`);

        const response = await this.xrayService.stopXrayForPanel(panelId);
        const data = errorHandler(response);

        return {
            response: data,
        };
    }

    @Get(XRAY_ROUTES.NODE_HEALTH_CHECK)
    public async getNodeHealthCheck(): Promise<GetNodeHealthCheckResponseDto> {
        const response = await this.xrayService.getNodeHealthCheck();
        const data = errorHandler(response);

        return {
            response: data,
        };
    }
}
