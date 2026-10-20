import { Command } from '@nestjs/cqrs';

/**
 * Moves the current Xray counters into the per-panel buffers. Sent right before the core
 * is stopped, because a restart resets the counters.
 */
export class DrainStatsCommand extends Command<void> {
    constructor() {
        super();
    }
}
