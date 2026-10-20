import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { COMMANDS } from './commands';
import { GeocheckService } from './geocheck.service';
import { StatsLedgerService } from './stats-ledger.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
    imports: [CqrsModule],
    providers: [StatsService, StatsLedgerService, GeocheckService, ...COMMANDS],
    controllers: [StatsController],
})
export class StatsModule {}
