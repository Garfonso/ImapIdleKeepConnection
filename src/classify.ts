import type { ImapFlowError } from 'imapflow';

/**
 * Why a connection attempt failed or a connection was lost.
 *
 * - `network`: the server was not reached (DNS, refused, timeout, connection dropped).
 *   No server contact, so no risk of a ban: retried forever with short delays.
 * - `auth`: the server rejected the credentials.
 * - `credentials`: the credentials callback failed (e.g. no new oauth token) while the
 *   server was reachable.
 * - `mailbox`: the mailbox does not exist.
 * - `throttle`: the server asked to slow down.
 * - `other`: everything else, e.g. protocol or TLS errors, temporary server problems.
 */
export type FailureKind = 'network' | 'auth' | 'credentials' | 'mailbox' | 'throttle' | 'other';

/** Error codes of Node (socket, DNS) and imapflow that mean: server not reached or connection gone. */
const NETWORK_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
    'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN',
    'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT',
    'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS',
]);

/** RFC 5530 response codes that mean "try again later", not "wrong credentials". */
const TEMPORARY_RESPONSE_CODES = new Set(['UNAVAILABLE', 'SERVERBUG', 'INUSE', 'LIMIT']);

export function classifyError(err: unknown): FailureKind {
    if (!err || typeof err !== 'object') {
        return 'other';
    }
    const e = err as ImapFlowError;
    if (e.code === 'ETHROTTLE') {
        return 'throttle';
    }
    if (e.serverResponseCode && TEMPORARY_RESPONSE_CODES.has(e.serverResponseCode.toUpperCase())) {
        return 'other';
    }
    if (e.authenticationFailed) {
        return 'auth';
    }
    if (e.mailboxMissing) {
        return 'mailbox';
    }
    if (e.code && NETWORK_CODES.has(e.code)) {
        return 'network';
    }
    if (e._err && e._err !== err) {
        return classifyError(e._err);
    }
    return 'other';
}

/** imapflow messages that say nothing beyond the server response. */
const GENERIC_MESSAGES = new Set(['Command failed', 'Authentication failed']);

/** one line description: message, server response and code if they add something. */
export function describeError(err: unknown): string {
    if (!(err instanceof Error)) {
        return String(err);
    }
    const e = err as ImapFlowError;
    let text = (e.message || e.name).split('\n')[0].trim();
    // openssl: '...:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:ssl/...'
    const ssl = /:error:[0-9A-F]+:[^:]*:[^:]*:([^:]+):/.exec(text);
    if (ssl) {
        text = 'TLS error: ' + ssl[1];
    }
    if (e.responseText && !text.includes(e.responseText)) {
        text = GENERIC_MESSAGES.has(text) ? e.responseText : text + ': ' + e.responseText;
    }
    if (e.serverResponseCode && !text.includes(e.serverResponseCode)) {
        text += ' [' + e.serverResponseCode + ']';
    }
    if (e.code && !text.includes(e.code)) {
        text += ' (' + e.code + ')';
    }
    return text;
}
