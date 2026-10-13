import { isIP } from 'node:net';

import { Logger } from '@nestjs/common';
import { IEventHandler, EventsHandler } from '@nestjs/cqrs';

import { fromXrayEmail, getPanel } from '@common/multi-panel';
import { formatExecutionTime, getTime } from '@common/utils/get-elapsed-time';
import { sendWebhook } from '@common/utils/send-webhook';
import { TorrentBlockerReportModel, XrayWebhookSchema } from '@libs/contracts/models';

import { NftService } from '../../services/nft.service';
import { PluginStateService } from '../../services/plugin-state.service';
import { XrayWebhookEvent } from './xray-webhook.event';

const SOURCE_REGEX = /^(?:(?:tcp|udp):)?(?:\[(.+?)\]|(.+?))(?::(\d+))?$/;

@EventsHandler(XrayWebhookEvent)
export class XrayWebhookHandler implements IEventHandler<XrayWebhookEvent> {
    public readonly logger = new Logger(XrayWebhookHandler.name);

    constructor(
        private readonly pluginState: PluginStateService,
        private readonly nftService: NftService,
    ) {}
    async handle(event: XrayWebhookEvent) {
        const ct = getTime();
        try {
            if (!this.pluginState.torrentBlocker.isEnabled) return;

            const parsed = await XrayWebhookSchema.safeParseAsync(event.webhook);
            if (!parsed.success) {
                this.logger.error(`Invalid webhook: ${JSON.stringify(parsed.error)}`);
                return;
            }

            this.logger.debug(JSON.stringify(parsed.data, null, 2));

            const ip = this.extractIp(parsed.data.source);

            if (!ip || !parsed.data.email) return;

            // Users of secondary panels are namespaced inside Xray, panels expect their own ids.
            const owner = fromXrayEmail(parsed.data.email);
            const webhook = { ...parsed.data, email: owner.username };

            if (!getPanel(owner.panelId)) {
                this.logger.warn(`Webhook for user of unknown panel #${owner.panelId}, skipping.`);
                return;
            }

            const whitelisted =
                this.pluginState.torrentBlocker.isIpIgnored(ip) ||
                this.pluginState.torrentBlocker.isUserIgnored(owner.username);

            if (whitelisted) {
                return;
            }

            const blockDuration = this.pluginState.torrentBlocker.duration!;

            let blocked = false;

            try {
                await this.nftService.blockIp(ip, blockDuration);
                blocked = true;

                this.logger.log(
                    `[TORRENT-BLOCKER] IP: ${ip}, user: ${webhook.email} (panel #${owner.panelId}), blocked: ${blocked}, duration: ${blockDuration}s`,
                );
            } catch (error) {
                this.logger.error(`Failed to block IP ${ip}: ${error}`);
            }

            const report: TorrentBlockerReportModel = {
                actionReport: {
                    blocked,
                    ip,
                    blockDuration,
                    willUnblockAt: new Date(Date.now() + blockDuration * 1000),
                    userId: webhook.email,
                    processedAt: new Date(),
                },
                xrayReport: webhook,
            };

            this.pluginState.torrentBlocker.addReport(owner.panelId, report);

            const webhookUrl = this.pluginState.torrentBlocker.getWebhookUrl();

            if (webhookUrl) {
                sendWebhook(webhookUrl, report);
            }
        } catch (error) {
            this.logger.error(`Error in Event XrayWebhookHandler: ${error}`);
        } finally {
            this.logger.debug(`Webhook handled in: ${formatExecutionTime(ct)}`);
        }
    }

    private extractIp(source: string | null): string | null {
        if (!source) return null;

        const prefixMatch = source.match(SOURCE_REGEX);
        const candidate = prefixMatch ? prefixMatch[1] || prefixMatch[2] : source;

        if (isIP(candidate) === 0) return null;

        return candidate;
    }
}
