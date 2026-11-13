/** 0s, 250ms, 30s, 5min, 1.5h */
export function formatDuration(ms: number): string {
    if (ms > 0 && ms < 1000) {
        return ms + 'ms';
    }
    if (ms < 60 * 1000) {
        return Math.round(ms / 1000) + 's';
    }
    if (ms < 60 * 60 * 1000) {
        return Math.round(ms / (60 * 1000)) + 'min';
    }
    return Number((ms / (60 * 60 * 1000)).toFixed(1)) + 'h';
}
