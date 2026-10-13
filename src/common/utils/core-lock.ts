import { getSemaphore } from '@henrygd/semaphore';

const CORE_LOCK_KEY = Symbol.for('rw-node.xray-core-lock');

/**
 * Serializes operations that mutate the Xray Core state (start / stop / user changes).
 * With several panels attached, their requests can arrive at the same time.
 */
export async function withCoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const semaphore = getSemaphore(CORE_LOCK_KEY);

    await semaphore.acquire();

    try {
        return await fn();
    } finally {
        semaphore.release();
    }
}
