import { EventEmitter } from 'node:events';
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import type { Logger } from '../src/index.ts';

type Behaviour = (client: FakeClient) => Promise<void>;

/** stand-in for ImapFlow. connect() follows FakeClient.connectBehaviours, default: success. */
export class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];
    static connectBehaviours: Behaviour[] = [];
    options: ImapFlowOptions;
    opened: string | undefined;
    loggedOut = false;
    closed = false;
    locks = 0;

    constructor(options: ImapFlowOptions) {
        super();
        this.options = options;
        FakeClient.instances.push(this);
    }

    static reset(): void {
        FakeClient.instances = [];
        FakeClient.connectBehaviours = [];
    }

    static last(): FakeClient {
        const last = FakeClient.instances.at(-1);
        if (!last) {
            throw new Error('no client created');
        }
        return last;
    }

    static create = (options: ImapFlowOptions): ImapFlow => new FakeClient(options) as unknown as ImapFlow;

    connect(): Promise<void> {
        const behaviour = FakeClient.connectBehaviours.shift();
        return behaviour ? behaviour(this) : Promise.resolve();
    }

    async mailboxOpen(path: string): Promise<{ path: string }> {
        this.opened = path;
        return { path };
    }

    async getMailboxLock(path: string): Promise<{ path: string; release(): void }> {
        this.locks += 1;
        return { path, release: () => { this.locks -= 1; } };
    }

    async logout(): Promise<void> {
        this.loggedOut = true;
        this.close();
    }

    close(): void {
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
        }
    }

    /** server side drops the connection. */
    drop(error?: Error): void {
        if (error) {
            this.emit('error', error);
        }
        this.close();
    }
}

export const fail = (error: Error): Behaviour => async client => {
    client.close();
    throw error;
};

export function networkError(code = 'ENOTFOUND'): Error {
    return Object.assign(new Error(code === 'ENOTFOUND' ? 'getaddrinfo ENOTFOUND imap.example.org' : 'connect ' + code), { code });
}

export function authError(responseText = 'Invalid credentials', serverResponseCode = 'AUTHENTICATIONFAILED'): Error {
    return Object.assign(new Error('Authentication failed'), { authenticationFailed: true, responseText, serverResponseCode, responseStatus: 'NO' });
}

export type LogEntry = [level: string, ...msgs: unknown[]];

export function recordingLogger(): Logger & { entries: LogEntry[]; lines(level?: string): string[] } {
    const entries: LogEntry[] = [];
    const push = (level: string) => (...msgs: unknown[]) => { entries.push([level, ...msgs]); };
    return {
        entries,
        debug: push('debug'),
        info: push('info'),
        error: push('error'),
        lines: (level?: string) => entries.filter(e => level ? e[0] === level : e[0] !== 'debug').map(e => e[0] + ' ' + e.slice(1).join(' ')),
    };
}

/** let pending promise callbacks run. */
export async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}
