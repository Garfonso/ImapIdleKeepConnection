import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import type { AuthOptions, ExistsEvent, ImapFlowError, ImapFlowOptions, Logger as ImapFlowLogger } from 'imapflow';
import { classifyError, describeError } from './classify.ts';
import type { FailureKind } from './classify.ts';
import { DEFAULT_DELAYS, retryDelay } from './delays.ts';
import type { RetryDelays } from './delays.ts';
import { formatDuration } from './format.ts';
import { isReachable } from './probe.ts';

/** a connection that lived this long was fine, losing it starts a new failure streak. */
export const STABLE_AFTER = 60 * 1000;
/** quiet failures (network, other) are reported again once a streak lasts this long. */
export const LONG_STREAK = 60 * 60 * 1000;
const LOGOUT_TIMEOUT = 3 * 1000;
const DEFAULT_MAX_IDLE_TIME = 2 * 60 * 1000;

export interface Logger {
    debug(...msgs: unknown[]): void;
    info(...msgs: unknown[]): void;
    error(...msgs: unknown[]): void;
}

export type Credentials =
    | { user: string; password: string; accessToken?: undefined; expires?: undefined }
    | {
        user: string;
        accessToken: string;
        /** token expiry: the connection is closed shortly before and reopened with new credentials. */
        expires?: Date | number;
        password?: undefined;
    };

/** called before every connection attempt, e.g. to get a fresh oauth access token. */
export type CredentialsProvider = () => Credentials | Promise<Credentials>;

export interface KeepConnectionOptions {
    host: string;
    /** default 993, or 143 without `secure`. */
    port?: number;
    /** TLS from the start (default). `false`: STARTTLS if the server supports it. */
    secure?: boolean;
    /** default INBOX */
    mailbox?: string;
    credentials: Credentials | CredentialsProvider;
    /** default: errors to console.error, nothing else. */
    logger?: Logger;
    /** log imapflow's own messages on debug level (no credentials). */
    trace?: boolean;
    /** restart IDLE every n ms, default 2 minutes (outlook drops longer IDLEs). */
    maxIdleTime?: number;
    /** override wait times, see DEFAULT_DELAYS. */
    delays?: Partial<RetryDelays>;
    /** further imapflow options (timeouts, tls, ...). */
    imapOptions?: Omit<ImapFlowOptions, 'host' | 'port' | 'secure' | 'auth' | 'logger'>;
    /** for tests: create the imapflow client. */
    createClient?: (options: ImapFlowOptions) => ImapFlow;
    /** for tests: is the server reachable (used when the credentials callback fails)? */
    probe?: (host: string, port: number) => Promise<boolean>;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export interface ConnectionStatus {
    state: ConnectionState;
    /** state since */
    since: Date;
    /** failed attempts in a row */
    failures: number;
    failureKind?: FailureKind;
    lastError?: string;
    nextAttempt?: Date;
    /** successful connections, including reconnects */
    connects: number;
    /** mail events */
    mails: number;
}

export interface FailureInfo {
    kind: FailureKind;
    error: Error;
    /** failed attempts in a row */
    failures: number;
    /** ms until the next attempt */
    retryIn: number;
    /** a connection that worked for a while was lost (normal for some servers). */
    lost: boolean;
}

export interface MailInfo {
    count: number;
    prevCount: number;
}

export interface KeepConnectionEvents {
    /** connected, authenticated and mailbox opened. Again after every reconnect: check for mails. */
    ready: [client: ImapFlow];
    /** new messages in the mailbox */
    mail: [info: MailInfo];
    /** an attempt failed or the connection was lost, next attempt is scheduled. */
    failure: [info: FailureInfo];
}

interface Streak {
    start: number;
    /** failed connection attempts (lost connections not counted) */
    attempts: number;
    kind: FailureKind;
    /** failures of `kind` in a row, selects the delay */
    kindCount: number;
    /** "still failing" was logged */
    reported: boolean;
    /** kind that was logged on info/error level already */
    announced?: FailureKind;
}

const LABELS: Record<FailureKind, string> = {
    network: 'Server not reachable',
    auth: 'Authentication failed',
    credentials: 'Could not get credentials',
    mailbox: 'Mailbox not available',
    throttle: 'Throttled by server',
    other: 'Connection failed',
};

/**
 * One IMAP connection that watches a mailbox with IDLE and keeps itself alive:
 * reconnects with backoff depending on why it failed, gets fresh credentials for every attempt
 * and never gives up (stop() ends it).
 */
export class KeepConnection extends EventEmitter<KeepConnectionEvents> {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly mailbox: string;

    #options: KeepConnectionOptions;
    #log: Logger;
    #delays: RetryDelays;
    #createClient: (options: ImapFlowOptions) => ImapFlow;
    #probe: (host: string, port: number) => Promise<boolean>;

    #client: ImapFlow | undefined;
    #connected = false;
    #state: ConnectionState = 'idle';
    #since = new Date();
    #streak: Streak | undefined;
    #lastError: string | undefined;
    #timer: NodeJS.Timeout | undefined;
    #nextAttempt: Date | undefined;
    #readyAt = 0;
    #connects = 0;
    #mails = 0;

    constructor(options: KeepConnectionOptions) {
        super();
        this.#options = options;
        this.host = options.host;
        this.secure = options.secure ?? true;
        this.port = options.port ?? (this.secure ? 993 : 143);
        this.mailbox = options.mailbox ?? 'INBOX';
        const logger = options.logger;
        this.#log = logger ? {
            debug: (...msgs) => logger.debug(...msgs),
            info: (...msgs) => logger.info(...msgs),
            error: (...msgs) => logger.error(...msgs),
        } : { debug: () => {}, info: () => {}, error: (...msgs) => console.error(...msgs) };
        this.#delays = { ...DEFAULT_DELAYS, ...options.delays };
        this.#createClient = options.createClient ?? (clientOptions => new ImapFlow(clientOptions));
        this.#probe = options.probe ?? isReachable;
    }

    /** connect and keep connected until stop(). */
    start(): void {
        if (this.#state === 'idle') {
            void this.#connect();
        }
    }

    /** the imapflow client while connected (mailbox is selected). */
    get client(): ImapFlow | undefined {
        return this.#connected ? this.#client : undefined;
    }

    get state(): ConnectionState {
        return this.#state;
    }

    get status(): ConnectionStatus {
        const connected = this.#state === 'connected';
        return {
            state: this.#state,
            since: this.#since,
            failures: connected ? 0 : this.#streak?.attempts ?? 0,
            failureKind: connected ? undefined : this.#streak?.kind,
            lastError: this.#lastError,
            nextAttempt: this.#nextAttempt,
            connects: this.#connects,
            mails: this.#mails,
        };
    }

    /**
     * Run fn with the mailbox locked, so it does not interfere with other commands.
     * Throws if not connected.
     */
    async withMailbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
        const client = this.client;
        if (!client) {
            throw new Error('Not connected.');
        }
        const lock = await client.getMailboxLock(this.mailbox);
        try {
            return await fn(client);
        } finally {
            lock.release();
        }
    }

    /** if waiting for the next attempt: try now (e.g. another connection says the network is back). */
    retryNow(): void {
        if (this.#state === 'waiting') {
            clearTimeout(this.#timer);
            void this.#connect();
        }
    }

    /** log out and never reconnect. */
    async stop(): Promise<void> {
        if (this.#state === 'stopped') {
            return;
        }
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#nextAttempt = undefined;
        this.#setState('stopped');
        const client = this.#client;
        this.#client = undefined;
        this.#connected = false;
        if (client) {
            await closeClient(client);
        }
    }

    async #connect(): Promise<void> {
        this.#timer = undefined;
        this.#nextAttempt = undefined;
        this.#setState('connecting');
        try {
            await this.#attempt();
        } catch (err) {
            // bug in a listener or here: don't end up without a scheduled attempt.
            if (this.#state === 'connecting') {
                this.#client = undefined;
                this.#connected = false;
                this.#fail('other', toError(err));
            } else {
                this.#log.error('Unexpected error:', describeError(err));
            }
        }
    }

    async #attempt(): Promise<void> {
        let auth: AuthOptions;
        let sessionExpires: Date | number | undefined;
        try {
            const credentials = typeof this.#options.credentials === 'function'
                ? await this.#options.credentials()
                : this.#options.credentials;
            ({ auth, sessionExpires } = toAuthOptions(credentials));
        } catch (err) {
            if (this.#state !== 'connecting') {
                return;
            }
            const reachable = await this.#probe(this.host, this.port);
            if (this.#state !== 'connecting') {
                return;
            }
            if (reachable) {
                this.#fail('credentials', toError(err));
            } else {
                this.#fail('network', new Error('no connection to ' + this.host + ':' + this.port +
                    ', credentials failed too: ' + describeError(err), { cause: err }));
            }
            return;
        }
        if (this.#state !== 'connecting') {
            return;
        }

        const client = this.#createClient({
            maxIdleTime: this.#options.maxIdleTime ?? DEFAULT_MAX_IDLE_TIME,
            ...this.#options.imapOptions,
            host: this.host,
            port: this.port,
            secure: this.secure,
            auth,
            sessionExpires,
            logger: imapLogger(this.#log, this.#options.trace ?? false),
        });
        this.#client = client;
        let clientError: Error | undefined;
        client.on('error', (err: Error) => {
            clientError = err;
            if (client === this.#client) {
                this.#log.debug('IMAP error:', describeError(err));
            }
        });
        client.on('close', () => this.#onClose(client, clientError));
        client.on('exists', (data: ExistsEvent) => this.#onExists(client, data));

        try {
            await client.connect();
            await client.mailboxOpen(this.mailbox);
        } catch (err) {
            if (client !== this.#client) {
                return; // stopped meanwhile
            }
            this.#client = undefined;
            client.close();
            this.#fail(classifyError(err), toError(err));
            return;
        }
        if (client === this.#client) {
            this.#onReady(client);
        }
    }

    #onReady(client: ImapFlow): void {
        const streak = this.#streak;
        this.#connected = true;
        this.#readyAt = Date.now();
        this.#connects += 1;
        this.#lastError = undefined;
        this.#setState('connected');
        if (streak && streak.attempts > 0) {
            this.#log.info('Connected again after ' + formatDuration(Date.now() - streak.start) + ', ' +
                streak.attempts + ' failed attempt' + (streak.attempts > 1 ? 's' : '') + '.');
        } else if (this.#connects === 1) {
            this.#log.info('Connected.');
        } else {
            this.#log.debug('Reconnected.');
        }
        this.#emitSafe('ready', client);
    }

    #onClose(client: ImapFlow, err: Error | undefined): void {
        if (client !== this.#client || !this.#connected) {
            return; // old client, or still connecting (connect() rejects then)
        }
        this.#client = undefined;
        this.#connected = false;
        const stable = Date.now() - this.#readyAt >= STABLE_AFTER;
        if (stable) {
            this.#streak = undefined;
        }
        this.#fail(err ? classifyError(err) : 'network', err ?? new Error('Connection closed.'), stable ? 'stable' : 'unstable');
    }

    #onExists(client: ImapFlow, data: ExistsEvent): void {
        if (client !== this.#client || !this.#connected || data.count <= data.prevCount) {
            return;
        }
        this.#mails += 1;
        this.#log.debug('New mail, ' + data.count + ' messages.');
        this.#emitSafe('mail', { count: data.count, prevCount: data.prevCount });
    }

    /** drop: an established connection was lost, 'stable' if it worked for a while. */
    #fail(kind: FailureKind, error: Error, drop?: 'stable' | 'unstable'): void {
        const lost = drop === 'stable';
        const now = Date.now();
        const streak = this.#streak ??= { start: now, attempts: 0, kind, kindCount: 0, reported: false };
        if (streak.kind !== kind) {
            streak.kind = kind;
            streak.kindCount = 0;
        }
        streak.kindCount += 1;
        if (!drop) {
            streak.attempts += 1; // drops only raise the delay (kindCount)
        }
        const message = describeError(error);
        this.#lastError = message;
        const retryIn = this.#retryDelay(kind, streak.kindCount, error);
        this.#logFailure(streak, message, retryIn, drop);

        this.#setState('waiting');
        this.#nextAttempt = new Date(now + retryIn);
        this.#timer = setTimeout(() => void this.#connect(), retryIn);
        this.#emitSafe('failure', { kind, error, failures: streak.attempts, retryIn, lost });
    }

    #retryDelay(kind: FailureKind, count: number, error: Error): number {
        if (kind === 'throttle') {
            const reset = (error as ImapFlowError).throttleReset;
            return reset && reset > 0 ? reset : retryDelay(this.#delays.other, count);
        }
        let delays = this.#delays[kind];
        if (kind === 'auth' && typeof this.#options.credentials !== 'function') {
            delays = delays.slice(1);
        }
        return retryDelay(delays, count);
    }

    #logFailure(streak: Streak, message: string, retryIn: number, drop: 'stable' | 'unstable' | undefined): void {
        const label = drop ? 'Connection lost'
            : streak.kind === 'mailbox' ? 'Mailbox "' + this.mailbox + '" not available' : LABELS[streak.kind];
        const next = retryIn > 0 ? 'retry in ' + formatDuration(retryIn) : 'retry now';
        const times = streak.kindCount > 1 ? ' (' + streak.kindCount + ' times in a row)' : '';
        message = withoutPrefix(message, LABELS[streak.kind]);

        if (streak.kind === 'auth' || streak.kind === 'credentials' || streak.kind === 'mailbox') {
            // need attention and are rare thanks to the long delays: always one line.
            this.#log.error(label + times + message + ' - ' + next + '.');
            return;
        }
        if (drop === 'stable' && streak.kindCount === 1) {
            this.#log.debug(label + message + ' - reconnect in ' + formatDuration(retryIn) + '.');
            return;
        }
        if (streak.announced !== streak.kind) {
            streak.announced = streak.kind;
            const line = label + message + ' - ' + next + '.';
            if (streak.kind === 'other') {
                this.#log.error(line);
            } else {
                this.#log.info(line);
            }
            return;
        }
        const duration = Date.now() - streak.start;
        if (!streak.reported && duration >= LONG_STREAK) {
            streak.reported = true;
            this.#log.error('Still failing after ' + formatDuration(duration) + ' (' + streak.attempts + ' attempts): ' +
                label + message + ' - retrying every ' + formatDuration(retryIn) + '.');
            return;
        }
        this.#log.debug(label + times + message + ' - ' + next + '.');
    }

    #setState(state: ConnectionState): void {
        if (state !== this.#state) {
            this.#state = state;
            this.#since = new Date();
        }
    }

    #emitSafe<K extends keyof KeepConnectionEvents>(event: K, ...args: KeepConnectionEvents[K]): void {
        try {
            (this.emit as (event: K, ...args: KeepConnectionEvents[K]) => boolean)(event, ...args);
        } catch (err) {
            this.#log.error('Listener for "' + event + '" failed:', describeError(err));
        }
    }
}

/** ': details' without a repeated label, '' if the message is just the label. */
function withoutPrefix(message: string, label: string): string {
    if (message.toLowerCase() === label.toLowerCase()) {
        return '';
    }
    if (message.toLowerCase().startsWith(label.toLowerCase() + ': ')) {
        return ': ' + message.slice(label.length + 2);
    }
    return ': ' + message;
}

function toAuthOptions(credentials: Credentials): { auth: AuthOptions; sessionExpires?: Date | number } {
    if (!credentials || !credentials.user) {
        throw new Error('No user name.');
    }
    if (credentials.accessToken !== undefined) {
        if (!credentials.accessToken.trim()) {
            throw new Error('Empty access token.');
        }
        return { auth: { user: credentials.user, accessToken: credentials.accessToken.trim() }, sessionExpires: credentials.expires };
    }
    if (!credentials.password) {
        throw new Error('Neither password nor access token.');
    }
    return { auth: { user: credentials.user, pass: credentials.password } };
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

function imapLogger(log: Logger, trace: boolean): ImapFlowLogger | false {
    if (!trace) {
        return false;
    }
    const write = (entry: unknown) => {
        if (entry && typeof entry === 'object') {
            const { msg, ...rest } = entry as Record<string, unknown>;
            delete rest.cid;
            log.debug('imapflow: ' + String(msg ?? ''), Object.keys(rest).length ? rest : '');
        } else {
            log.debug('imapflow: ' + String(entry));
        }
    };
    return { debug: write, info: write, warn: write, error: write };
}

async function closeClient(client: ImapFlow): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            client.logout(),
            new Promise(resolve => { timer = setTimeout(resolve, LOGOUT_TIMEOUT); }),
        ]);
    } catch {
        // closing anyway
    } finally {
        clearTimeout(timer);
        client.close();
    }
}
