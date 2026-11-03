import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { LedgerRestartRequestDto } from './ledger.dto';
import { LedgerGuard } from './ledger.guard';
import { LedgerService } from './ledger.service';

/**
 * Ledger channel (docs: LEDGER.md): node status and core restart, nothing else.
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

    @Post('core/restart')
    public async restartCore(@Body() body: LedgerRestartRequestDto) {
        return { response: await this.ledgerService.restartCore(body?.reason) };
    }
}
