import { PRIMARY_PANEL_ID } from './panels';

/**
 * Every panel identifies users by its own numeric user id, which is used as the
 * `email` field inside Xray. Ids of different panels collide, so users of
 * secondary panels are namespaced: `p<panelId>.<username>`.
 *
 * Users of the primary panel are kept as-is, so a single-panel node behaves
 * exactly like upstream.
 */
const NAMESPACED_EMAIL_REGEX = /^p(\d+)\.(.+)$/s;

export function toXrayEmail(panelId: number, username: string): string {
    if (panelId === PRIMARY_PANEL_ID) {
        return username;
    }

    return `p${panelId}.${username}`;
}

export function fromXrayEmail(email: string): { panelId: number; username: string } {
    const match = NAMESPACED_EMAIL_REGEX.exec(email);

    if (match) {
        const panelId = Number(match[1]);

        if (Number.isInteger(panelId) && panelId > PRIMARY_PANEL_ID) {
            return { panelId, username: match[2] };
        }
    }

    return { panelId: PRIMARY_PANEL_ID, username: email };
}

/**
 * Returns the panel-local username if the email belongs to the given panel, otherwise null.
 */
export function ownUsername(panelId: number, email: string): null | string {
    const parsed = fromXrayEmail(email);

    return parsed.panelId === panelId ? parsed.username : null;
}
