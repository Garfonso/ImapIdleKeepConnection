/**
 * Real imapflow against the fake server.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KeepConnection } from '../src/index.ts';
import type { FailureInfo, KeepConnectionOptions } from '../src/index.ts';
import { startFakeServer } from './fakeImapServer.ts';
import type { FakeImapServer } from './fakeImapServer.ts';
import { recordingLogger } from './helpers.ts';

async function waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) {
            throw new Error('timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

const FAST = { network: [50], auth: [0, 100], credentials: [100], mailbox: [100], other: [50] };

describe('KeepConnection with imapflow', () => {
    let server: FakeImapServer | undefined;
    let connection: KeepConnection | undefined;
    let logger: ReturnType<typeof recordingLogger>;

    async function connect(options: Partial<KeepConnectionOptions> = {}): Promise<{ failures: FailureInfo[]; ready: () => number }> {
        server ??= await startFakeServer();
        logger = recordingLogger();
        let ready = 0;
        const failures: FailureInfo[] = [];
        connection = new KeepConnection({
            host: '127.0.0.1',
            port: server.port,
            secure: false,
            credentials: () => ({ user: 'me@example.org', accessToken: 'access-token' }),
            logger,
            delays: FAST,
            imapOptions: { autoIdleDelay: 20, disableAutoEnable: true },
            ...options,
        });
        connection.on('ready', () => { ready += 1; });
        connection.on('failure', info => failures.push(info));
        connection.start();
        return { failures, ready: () => ready };
    }

    afterEach(async () => {
        await connection?.stop();
        await server?.stop();
        connection = undefined;
        server = undefined;
    });

    it('logs in with XOAUTH2, idles and reports new mail', async () => {
        const { ready } = await connect();
        const mails: number[] = [];
        connection!.on('mail', info => mails.push(info.count));
        await waitFor(() => ready() === 1);
        assert.ok(server!.commands.some(c => c.startsWith('AUTHENTICATE XOAUTH2 ')));
        await waitFor(() => server!.commands.includes('IDLE'));
        server!.newMail();
        await waitFor(() => mails.length === 1);
        assert.deepEqual(mails, [2]);
        assert.deepEqual(logger.lines(), ['info Connected.']);
    });

    it('logs in with a password', async () => {
        const { ready } = await connect({ credentials: { user: 'me@example.org', password: 'secret' } });
        await waitFor(() => ready() === 1);
        assert.ok(server!.commands.some(c => c.startsWith('AUTHENTICATE PLAIN') || c.startsWith('LOGIN')));
    });

    it('classifies rejected credentials as auth error', async () => {
        const { failures } = await connect({ credentials: { user: 'me@example.org', password: 'wrong' } });
        await waitFor(() => failures.length === 1);
        assert.equal(failures[0].kind, 'auth');
        assert.match(logger.lines('error')[0], /^error Authentication failed.*Invalid credentials.* - retry in 100ms|^error Authentication failed.*Invalid credentials.* - retry now\.|^error Authentication failed.*Invalid credentials/);
    });

    it('classifies a refused connection as network error', async () => {
        server = await startFakeServer();
        const port = server.port;
        await server.stop();
        server = undefined;
        const { failures } = await connect({ port, credentials: () => ({ user: 'me@example.org', accessToken: 'access-token' }) });
        await waitFor(() => failures.length >= 1);
        assert.equal(failures[0].kind, 'network');
        assert.match(failures[0].error.message + (failures[0].error as { code?: string }).code, /ECONNREFUSED/);
    });

    it('classifies a missing mailbox', async () => {
        const { failures } = await connect({ mailbox: 'Nope' });
        await waitFor(() => failures.length === 1);
        assert.equal(failures[0].kind, 'mailbox');
    });

    it('reconnects when the server drops the connection', async () => {
        const { ready, failures } = await connect();
        await waitFor(() => ready() === 1);
        server!.dropConnections();
        await waitFor(() => ready() === 2);
        assert.equal(failures.length, 1);
        assert.equal(failures[0].kind, 'network');
    });

    it('never logs credentials, also with trace', async () => {
        const { ready } = await connect({ trace: true });
        await waitFor(() => ready() === 1);
        await connection!.stop();
        const all = JSON.stringify(logger.entries);
        assert.ok(logger.entries.length > 5, 'trace logs something');
        assert.ok(!all.includes('access-token'), 'no token');
        assert.ok(!all.includes(Buffer.from('user=me@example.org\x01auth=Bearer access-token\x01\x01').toString('base64')), 'no encoded token');
    });
});
