import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { KeepConnection } from '../src/index.ts';
import type { FailureInfo, KeepConnectionOptions, MailInfo } from '../src/index.ts';
import { authError, fail, FakeClient, flush, networkError, recordingLogger } from './helpers.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('KeepConnection', () => {
    let logger: ReturnType<typeof recordingLogger>;
    let connections: KeepConnection[];
    let tokens: number;

    function create(options: Partial<KeepConnectionOptions> = {}): KeepConnection {
        const connection = new KeepConnection({
            host: 'imap.example.org',
            credentials: () => ({ user: 'me@example.org', accessToken: 'token-' + (++tokens) }),
            logger,
            createClient: FakeClient.create,
            probe: async () => true,
            ...options,
        });
        connections.push(connection);
        return connection;
    }

    async function started(options: Partial<KeepConnectionOptions> = {}): Promise<KeepConnection> {
        const connection = create(options);
        connection.start();
        await flush();
        return connection;
    }

    /** advance mocked time, let the attempts run. */
    async function tick(ms: number): Promise<void> {
        mock.timers.tick(ms);
        await flush();
    }

    beforeEach(() => {
        FakeClient.reset();
        logger = recordingLogger();
        connections = [];
        tokens = 0;
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    });

    afterEach(async () => {
        await Promise.all(connections.map(c => c.stop()));
        mock.timers.reset();
    });

    describe('connecting', () => {
        it('connects with fresh credentials, opens the mailbox and emits ready', async () => {
            const ready: unknown[] = [];
            const connection = create({ mailbox: 'Archive' });
            connection.on('ready', client => ready.push(client));
            connection.start();
            await flush();

            const client = FakeClient.last();
            assert.equal(client.options.host, 'imap.example.org');
            assert.equal(client.options.port, 993);
            assert.equal(client.options.secure, true);
            assert.deepEqual(client.options.auth, { user: 'me@example.org', accessToken: 'token-1' });
            assert.equal(client.options.maxIdleTime, 2 * MINUTE);
            assert.equal(client.options.logger, false);
            assert.equal(client.opened, 'Archive');
            assert.deepEqual(ready, [client]);
            assert.equal(connection.client, client as unknown);
            assert.equal(connection.status.state, 'connected');
            assert.deepEqual(logger.lines(), ['info Connected.']);
        });

        it('uses password credentials and port 143 without tls', async () => {
            await started({ credentials: { user: 'me', password: 'pw' }, secure: false });
            assert.deepEqual(FakeClient.last().options.auth, { user: 'me', pass: 'pw' });
            assert.equal(FakeClient.last().options.port, 143);
            assert.equal(FakeClient.last().options.secure, false);
        });

        it('passes the token expiry to imapflow', async () => {
            const expires = new Date(HOUR);
            await started({ credentials: async () => ({ user: 'me', accessToken: 't', expires }) });
            assert.equal(FakeClient.last().options.sessionExpires, expires);
        });

        it('emits mail only for new messages of the current connection', async () => {
            const mails: MailInfo[] = [];
            const connection = await started();
            connection.on('mail', info => mails.push(info));
            const client = FakeClient.last();
            client.emit('exists', { path: 'INBOX', count: 5, prevCount: 4 });
            client.emit('exists', { path: 'INBOX', count: 4, prevCount: 5 }); // expunge
            assert.deepEqual(mails, [{ count: 5, prevCount: 4 }]);
            assert.equal(connection.status.mails, 1);

            client.drop();
            client.emit('exists', { path: 'INBOX', count: 6, prevCount: 5 });
            assert.equal(mails.length, 1, 'closed client ignored');
        });

        it('keeps going if a listener throws', async () => {
            const connection = create();
            connection.on('ready', () => { throw new Error('listener bug'); });
            connection.start();
            await flush();
            assert.equal(connection.state, 'connected');
            assert.deepEqual(logger.lines('error'), ['error Listener for "ready" failed: listener bug']);
        });
    });

    describe('network errors', () => {
        it('retries forever with short delays and logs only the start, one hour and the end', async () => {
            const failures: FailureInfo[] = [];
            FakeClient.connectBehaviours = Array.from({ length: 40 }, () => fail(networkError()));
            const connection = create();
            connection.on('failure', info => failures.push(info));
            connection.start();
            await flush();
            assert.deepEqual(logger.lines(), ['info Server not reachable: getaddrinfo ENOTFOUND imap.example.org - retry in 10s.']);
            assert.equal(failures[0].kind, 'network');
            assert.equal(failures[0].retryIn, 10 * SECOND);

            const delays = [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 5 * MINUTE];
            for (const delay of delays) {
                assert.equal(FakeClient.instances.length, failures.length);
                await tick(delay - 1);
                assert.equal(FakeClient.instances.length, failures.length, 'waits ' + delay);
                await tick(1);
            }
            assert.equal(failures.at(-1)?.retryIn, 5 * MINUTE);

            for (let i = 0; i < 12; i += 1) {
                await tick(5 * MINUTE);
            }
            const lines = logger.lines();
            assert.equal(lines.length, 2);
            assert.match(lines[1], /^error Still failing after 1(\.\d)?h \(\d+ attempts\): Server not reachable: .* - retrying every 5min\.$/);

            FakeClient.connectBehaviours = [];
            await tick(5 * MINUTE);
            assert.equal(connection.state, 'connected');
            assert.match(logger.lines().at(-1) ?? '', /^info Connected again after 1\.\dh, \d+ failed attempts\.$/);
            assert.equal(logger.lines().length, 3);
        });

        it('shows the waiting state in the status', async () => {
            FakeClient.connectBehaviours = [fail(networkError('ECONNREFUSED'))];
            const connection = await started();
            assert.deepEqual({ ...connection.status, since: undefined }, {
                state: 'waiting', since: undefined, failures: 1, failureKind: 'network',
                lastError: 'connect ECONNREFUSED', nextAttempt: new Date(10 * SECOND), connects: 0, mails: 0,
            });
        });

        it('reconnects quietly after a connection that worked was lost', async () => {
            const connection = await started();
            await tick(30 * MINUTE);
            FakeClient.last().drop(networkError('ECONNRESET'));
            assert.equal(connection.state, 'waiting');
            assert.equal(connection.status.failures, 0);
            await tick(10 * SECOND);
            assert.equal(connection.state, 'connected');
            assert.deepEqual(logger.lines(), ['info Connected.'], 'lost + reconnected only on debug');
            assert.ok(logger.lines('debug').some(l => l === 'debug Connection lost: connect ECONNRESET - reconnect in 10s.'));
        });

        it('backs off if connections are lost right after connecting', async () => {
            await started();
            const delays: number[] = [];
            for (let i = 0; i < 4; i += 1) {
                FakeClient.last().drop();
                const before = FakeClient.instances.length;
                let waited = 0;
                while (FakeClient.instances.length === before) {
                    await tick(SECOND);
                    waited += SECOND;
                }
                delays.push(waited);
            }
            assert.deepEqual(delays, [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE]);
            assert.deepEqual(logger.lines(), ['info Connected.', 'info Connection lost: Connection closed. - retry in 10s.'],
                'first quick drop on info, repeated ones on debug');
        });
    });

    describe('authentication errors', () => {
        it('retries right away with a new token, then backs off', async () => {
            FakeClient.connectBehaviours = [fail(authError()), fail(authError()), fail(authError())];
            const connection = await started();
            await tick(0);
            assert.equal(FakeClient.instances.length, 2, 'immediate retry');
            assert.equal(FakeClient.instances[1].options.auth?.accessToken, 'token-2', 'fresh token');

            await tick(5 * MINUTE - 1);
            assert.equal(FakeClient.instances.length, 2);
            await tick(1);
            assert.equal(FakeClient.instances.length, 3);
            assert.equal(connection.status.nextAttempt?.getTime(), Date.now() + 10 * MINUTE);

            assert.deepEqual(logger.lines(), [
                'error Authentication failed: Invalid credentials [AUTHENTICATIONFAILED] - retry now.',
                'error Authentication failed (2 times in a row): Invalid credentials [AUTHENTICATIONFAILED] - retry in 5min.',
                'error Authentication failed (3 times in a row): Invalid credentials [AUTHENTICATIONFAILED] - retry in 10min.',
            ]);
        });

        it('starts with 5 minutes for static credentials and caps at 6 hours', async () => {
            FakeClient.connectBehaviours = Array.from({ length: 20 }, () => fail(authError()));
            const failures: FailureInfo[] = [];
            const connection = create({ credentials: { user: 'me', password: 'wrong' } });
            connection.on('failure', info => failures.push(info));
            connection.start();
            await flush();
            assert.equal(failures[0].retryIn, 5 * MINUTE);
            for (let i = 0; i < 12; i += 1) {
                await tick(6 * HOUR);
            }
            assert.equal(failures.at(-1)?.retryIn, 6 * HOUR);
        });

        it('treats temporary server answers as other errors', async () => {
            const failures: FailureInfo[] = [];
            FakeClient.connectBehaviours = [fail(authError('Server busy', 'UNAVAILABLE'))];
            const connection = create();
            connection.on('failure', info => failures.push(info));
            connection.start();
            await flush();
            assert.equal(failures[0].kind, 'other');
            assert.equal(failures[0].retryIn, 30 * SECOND);
        });
    });

    describe('credentials errors', () => {
        it('waits for the network if the server is not reachable either', async () => {
            const connection = await started({
                credentials: async () => { throw new Error('token endpoint: connection error'); },
                probe: async () => false,
            });
            assert.equal(connection.status.failureKind, 'network');
            assert.deepEqual(logger.lines(), ['info Server not reachable: no connection to imap.example.org:993, credentials failed too: token endpoint: connection error - retry in 10s.']);
            assert.equal(FakeClient.instances.length, 0, 'no connection without credentials');
        });

        it('backs off if the server is reachable (token problem)', async () => {
            let fails = true;
            const connection = await started({
                credentials: async () => {
                    if (fails) {
                        throw new Error('invalid_grant');
                    }
                    return { user: 'me', accessToken: 't' };
                },
            });
            assert.equal(connection.status.failureKind, 'credentials');
            await tick(MINUTE);
            assert.deepEqual(logger.lines(), [
                'error Could not get credentials: invalid_grant - retry in 1min.',
                'error Could not get credentials (2 times in a row): invalid_grant - retry in 5min.',
            ]);
            fails = false;
            await tick(5 * MINUTE);
            assert.equal(connection.state, 'connected');
        });

        it('rejects empty tokens', async () => {
            const connection = await started({ credentials: () => ({ user: 'me', accessToken: ' \n' }) });
            assert.equal(connection.status.lastError, 'Empty access token.');
            assert.equal(FakeClient.instances.length, 0);
        });
    });

    describe('other errors', () => {
        it('uses the delay the server asked for when throttled', async () => {
            const failures: FailureInfo[] = [];
            FakeClient.connectBehaviours = [fail(Object.assign(new Error('Throttled'), { code: 'ETHROTTLE', throttleReset: 7 * MINUTE }))];
            const connection = create();
            connection.on('failure', info => failures.push(info));
            connection.start();
            await flush();
            assert.equal(failures[0].kind, 'throttle');
            assert.equal(failures[0].retryIn, 7 * MINUTE);
        });

        it('reports a missing mailbox', async () => {
            FakeClient.connectBehaviours = [async client => {
                client.mailboxOpen = async () => { throw Object.assign(new Error('Mailbox does not exist'), { mailboxMissing: true }); };
            }];
            await started({ mailbox: 'Nope' });
            assert.deepEqual(logger.lines(), ['error Mailbox "Nope" not available: Mailbox does not exist - retry in 5min.']);
        });
    });

    describe('control', () => {
        it('stop() logs out and never reconnects', async () => {
            const connection = await started();
            const client = FakeClient.last();
            await connection.stop();
            assert.equal(client.loggedOut, true);
            assert.equal(connection.state, 'stopped');
            assert.equal(connection.client, undefined);
            await tick(24 * HOUR);
            assert.equal(FakeClient.instances.length, 1);
        });

        it('stop() while waiting cancels the attempt', async () => {
            FakeClient.connectBehaviours = [fail(networkError())];
            const connection = await started();
            await connection.stop();
            await tick(HOUR);
            assert.equal(FakeClient.instances.length, 1);
        });

        it('stop() while connecting: no ready, no retry', async () => {
            let release!: () => void;
            FakeClient.connectBehaviours = [() => new Promise<void>(resolve => { release = resolve; })];
            const connection = create();
            let ready = 0;
            connection.on('ready', () => { ready += 1; });
            connection.start();
            await flush();
            await connection.stop();
            release();
            await tick(HOUR);
            assert.equal(ready, 0);
            assert.equal(FakeClient.instances.length, 1);
            assert.equal(FakeClient.last().closed, true);
        });

        it('retryNow() skips the wait', async () => {
            FakeClient.connectBehaviours = [fail(authError()), fail(authError())];
            const connection = await started();
            await tick(0);
            assert.equal(connection.state, 'waiting');
            connection.retryNow();
            await flush();
            assert.equal(connection.state, 'connected');
            assert.equal(FakeClient.instances.length, 3);
        });

        it('withMailbox() locks the mailbox while connected', async () => {
            const connection = create();
            await assert.rejects(connection.withMailbox(async () => 1), /Not connected/);
            connection.start();
            await flush();
            const result = await connection.withMailbox(async client => {
                assert.equal((client as unknown as FakeClient).locks, 1);
                return 42;
            });
            assert.equal(result, 42);
            assert.equal(FakeClient.last().locks, 0);
        });
    });
});
