import { createHash } from 'node:crypto';

/**
 * JSON with sorted keys, formatted exactly like Python's
 * `json.dumps(value, sort_keys=True, ensure_ascii=False)`, so ledger and the node compute
 * the same config hash. (Floats with a zero fraction, e.g. 1.0, are the only difference:
 * Python prints "1.0", JS "1". Xray configs don't use them.)
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(', ')}]`;
    }

    const entries = Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map(
            (key) =>
                `${JSON.stringify(key)}: ${canonicalJson((value as Record<string, unknown>)[key])}`,
        );

    return `{${entries.join(', ')}}`;
}

export function canonicalHash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
