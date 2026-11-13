import type { FailureKind } from './classify.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Wait time before the next attempt, per failure kind, indexed by the number of failures of
 * that kind in a row. The last entry repeats. `throttle` uses the delay the server asked for,
 * `other` as fallback.
 */
export type RetryDelays = Record<Exclude<FailureKind, 'throttle'>, number[]>;

export const DEFAULT_DELAYS: RetryDelays = {
    network: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
    // the first entry (retry right away) is only used if credentials come from a callback,
    // a fresh token may fix it. Static credentials start with 5 minutes.
    auth: [0, 5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE, 80 * MINUTE, 160 * MINUTE, 320 * MINUTE, 6 * HOUR],
    credentials: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR],
    mailbox: [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR],
    other: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE],
};

/** delay after the given number of failures in a row (1 = first failure). */
export function retryDelay(delays: number[], failures: number): number {
    if (delays.length === 0) {
        return 0;
    }
    return delays[Math.min(Math.max(failures, 1), delays.length) - 1];
}
