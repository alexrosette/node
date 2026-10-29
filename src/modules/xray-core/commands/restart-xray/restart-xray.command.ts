import { Command } from '@nestjs/cqrs';

/**
 * Plugins changed in a way that needs a fresh core. Upstream stops the core and waits for
 * the panel to start it again; here the core is restarted at once with the users of every
 * panel (see XrayService.restartCoreKeepingPanels).
 */
export class RestartXrayCommand extends Command<void> {
    constructor(public readonly reason: string) {
        super();
    }
}
