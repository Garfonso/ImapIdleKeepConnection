export { KeepConnection, LONG_STREAK, STABLE_AFTER } from './keepConnection.ts';
export type {
    ConnectionState,
    ConnectionStatus,
    Credentials,
    CredentialsProvider,
    FailureInfo,
    KeepConnectionEvents,
    KeepConnectionOptions,
    Logger,
    MailInfo,
} from './keepConnection.ts';
export { classifyError, describeError } from './classify.ts';
export type { FailureKind } from './classify.ts';
export { DEFAULT_DELAYS, retryDelay } from './delays.ts';
export type { RetryDelays } from './delays.ts';
export { formatDuration } from './format.ts';
export { isReachable } from './probe.ts';
// imapflow types, so users don't need imapflow as own dependency for typing the client.
export type { ImapFlow, ImapFlowError, SearchObject, FetchMessageObject, FetchQueryObject } from 'imapflow';
