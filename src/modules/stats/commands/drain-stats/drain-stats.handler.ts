import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { StatsLedgerService } from '../../stats-ledger.service';
import { DrainStatsCommand } from './drain-stats.command';

@CommandHandler(DrainStatsCommand)
export class DrainStatsHandler implements ICommandHandler<DrainStatsCommand> {
    public readonly logger = new Logger(DrainStatsHandler.name);

    constructor(private readonly ledger: StatsLedgerService) {}

    async execute() {
        try {
            await this.ledger.drain();
        } catch (error) {
            this.logger.error(error);
        }
    }
}
