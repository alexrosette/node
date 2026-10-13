import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { PRIMARY_PANEL_ID } from './panels';

/**
 * Property attached to the raw Node.js request by the per-panel HTTPS servers.
 * It is never read from headers or the body, so it can't be spoofed by a client.
 */
export const PANEL_ID_PROPERTY = Symbol.for('rw-node.panel-id');

type TRequestWithPanel = { [PANEL_ID_PROPERTY]?: number };

export function setRequestPanelId(req: object, panelId: number): void {
    (req as TRequestWithPanel)[PANEL_ID_PROPERTY] = panelId;
}

export function getRequestPanelId(req: object): number {
    return (req as TRequestWithPanel)[PANEL_ID_PROPERTY] ?? PRIMARY_PANEL_ID;
}

export const PanelId = createParamDecorator((_: unknown, ctx: ExecutionContext): number => {
    return getRequestPanelId(ctx.switchToHttp().getRequest());
});
