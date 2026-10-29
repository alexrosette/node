import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { XrayService } from '../../xray.service';
import { RestartXrayCommand } from './restart-xray.command';

@CommandHandler(RestartXrayCommand)
export class RestartXrayHandler implements ICommandHandler<RestartXrayCommand> {
    public readonly logger = new Logger(RestartXrayHandler.name);

    constructor(private readonly xrayService: XrayService) {}

    async execute(command: RestartXrayCommand) {
        try {
            await this.xrayService.restartCoreKeepingPanels(command.reason);

            return;
        } catch (error) {
            this.logger.error(error);
            return;
        }
    }
}
