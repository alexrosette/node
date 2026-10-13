import { Logger } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PluginStateService } from '../../services/plugin-state.service';
import { GetTorrentBlockerReportsCountQuery } from './get-torrent-blocker-reports-count.query';

@QueryHandler(GetTorrentBlockerReportsCountQuery)
export class GetTorrentBlockerReportsCountHandler implements IQueryHandler<GetTorrentBlockerReportsCountQuery> {
    private readonly logger = new Logger(GetTorrentBlockerReportsCountHandler.name);
    constructor(private readonly pluginState: PluginStateService) {}

    async execute(query: GetTorrentBlockerReportsCountQuery) {
        try {
            const reportsCount = this.pluginState.torrentBlocker.reportsCount(query.panelId);

            return reportsCount;
        } catch (error) {
            this.logger.error(error);
            return 0;
        }
    }
}
