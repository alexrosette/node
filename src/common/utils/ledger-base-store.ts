import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_STATE_DIR = '/var/lib/remnanode';
const BASE_FILE = 'base-config.json';

export interface ISavedLedgerBase {
    config: Record<string, unknown>;
    updatedAt: string;
}

export function getLedgerStateDir(): string {
    const dir = process.env.LEDGER_STATE_DIR?.trim();

    return dir ? dir : DEFAULT_STATE_DIR;
}

/**
 * Writes the base config atomically (tmp file + fsync + rename), dir 0700, file 0600.
 */
export async function saveLedgerBase(base: ISavedLedgerBase): Promise<void> {
    const dir = getLedgerStateDir();
    const target = join(dir, BASE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;

    await mkdir(dir, { recursive: true, mode: 0o700 });

    const file = await open(tmp, 'w', 0o600);

    try {
        await file.writeFile(JSON.stringify(base), 'utf8');
        await file.sync();
    } finally {
        await file.close();
    }

    try {
        await rename(tmp, target);
    } catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }

    const dirHandle = await open(dir, 'r');

    try {
        await dirHandle.sync();
    } finally {
        await dirHandle.close();
    }
}

/**
 * Returns null if nothing was saved yet. A broken file is an error (it must not be
 * silently replaced by the base of a panel).
 */
export async function readLedgerBase(): Promise<ISavedLedgerBase | null> {
    let raw: string;

    try {
        raw = await readFile(join(getLedgerStateDir(), BASE_FILE), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }

    const parsed = JSON.parse(raw) as Partial<ISavedLedgerBase>;

    if (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
        throw new Error(`${BASE_FILE}: "config" must be an object`);
    }

    return {
        config: parsed.config,
        updatedAt:
            typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
}
