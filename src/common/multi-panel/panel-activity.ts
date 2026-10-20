/**
 * When each panel last talked to the node (for /node/ledger/status).
 */
const activity = new Map<number, { lastStartAt: Date | null; lastRequestAt: Date | null }>();

function entry(panelId: number) {
    let item = activity.get(panelId);

    if (!item) {
        item = { lastStartAt: null, lastRequestAt: null };
        activity.set(panelId, item);
    }

    return item;
}

export function markPanelRequest(panelId: number): void {
    entry(panelId).lastRequestAt = new Date();
}

export function markPanelStart(panelId: number): void {
    entry(panelId).lastStartAt = new Date();
}

export function getPanelActivity(panelId: number): {
    lastStartAt: Date | null;
    lastRequestAt: Date | null;
} {
    return { ...entry(panelId) };
}
