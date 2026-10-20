import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';

import { LedgerRestartRequestDto, PutLedgerConfigRequestDto } from './ledger.dto';
import { LedgerGuard } from './ledger.guard';
import { LedgerService } from './ledger.service';

/**
 * Control plane for ledger (docs: MULTI_PANEL.md, "Управление из ledger").
 * Reachable only over the ledger TLS identity (SNI + its own CA) and a ledger JWT.
 */
@UseGuards(LedgerGuard)
@Controller('ledger')
export class LedgerController {
    constructor(private readonly ledgerService: LedgerService) {}

    @Get('status')
    public async getStatus() {
        return { response: await this.ledgerService.getStatus() };
    }

    @Get('config')
    public getConfig() {
        return { response: this.ledgerService.getConfig() };
    }

    @Put('config')
    public async putConfig(@Body() body: PutLedgerConfigRequestDto) {
        return { response: await this.ledgerService.putConfig(body.config, body.baseHash) };
    }

    @Post('core/restart')
    public async restartCore(@Body() body: LedgerRestartRequestDto) {
        return { response: await this.ledgerService.restartCore(body?.reason) };
    }

    @Post('core/stop')
    public async stopCore() {
        return { response: await this.ledgerService.stopCore() };
    }

    @Post('core/start')
    public async startCore() {
        return { response: await this.ledgerService.startCore() };
    }
}
