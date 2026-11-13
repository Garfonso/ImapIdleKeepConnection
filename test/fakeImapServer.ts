/**
 * Minimal IMAP server for tests, enough for imapflow to log in (XOAUTH2, PLAIN, LOGIN),
 * select a mailbox and IDLE. Default capabilities like outlook.com.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const CRLF = '\r\n';

export interface FakeServerOptions {
    port?: number;
    capabilities?: string;
    /** user -> password or access token */
    accounts?: Record<string, { password?: string; token?: string }>;
    mailboxes?: string[];
}

export interface FakeImapServer {
    port: number;
    /** all commands received (without tag). */
    commands: string[];
    /** send EXISTS to all idling connections. */
    newMail(): void;
    /** drop all connections, keep listening. */
    dropConnections(): void;
    /** drop all connections and stop listening. */
    stop(): Promise<void>;
    connections(): number;
}

export const OUTLOOK_CAPABILITIES = 'IMAP4 IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2 SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN IDLE NAMESPACE LITERAL+';

function unquote(value: string): string {
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export function startFakeServer(options: FakeServerOptions = {}): Promise<FakeImapServer> {
    const capabilities = options.capabilities ?? OUTLOOK_CAPABILITIES;
    const accounts = options.accounts ?? { 'me@example.org': { token: 'access-token', password: 'secret' } };
    const mailboxes = options.mailboxes ?? ['INBOX'];
    const commands: string[] = [];
    const sockets = new Set<net.Socket>();
    let exists = 1;
    const idling = new Map<net.Socket, string>();

    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => { sockets.delete(socket); idling.delete(socket); });
        socket.on('error', () => {});
        socket.write('* OK fake imap ready' + CRLF);
        let buffer = '';
        let pendingAuth: { tag: string; mechanism: string } | undefined;

        const login = (tag: string, user: string, ok: boolean) => {
            if (ok) {
                socket.write(tag + ' OK [CAPABILITY ' + capabilities + '] ' + user + ' authenticated' + CRLF);
            } else {
                socket.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials' + CRLF);
            }
        };
        const sasl = (tag: string, mechanism: string, data: string) => {
            const decoded = Buffer.from(data, 'base64').toString('utf8');
            if (mechanism === 'XOAUTH2') {
                // user=<user>^Aauth=Bearer <token>^A^A
                const parts = decoded.split(String.fromCharCode(1));
                const user = parts.find(p => p.startsWith('user='))?.slice(5) ?? '';
                const token = parts.find(p => p.startsWith('auth=Bearer '))?.slice(12);
                login(tag, user, !!token && accounts[user]?.token === token);
            } else {
                const [, user, password] = decoded.split('\x00');
                login(tag, user, !!password && accounts[user]?.password === password);
            }
        };

        socket.on('data', data => {
            buffer += data.toString('utf8');
            let index;
            while ((index = buffer.indexOf(CRLF)) > -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (pendingAuth) {
                    const { tag, mechanism } = pendingAuth;
                    pendingAuth = undefined;
                    sasl(tag, mechanism, line);
                    continue;
                }
                if (line === 'DONE' && idling.has(socket)) {
                    socket.write(idling.get(socket) + ' OK IDLE terminated' + CRLF);
                    idling.delete(socket);
                    continue;
                }
                const [tag, name = '', ...args] = line.split(' ');
                const command = name.toUpperCase();
                commands.push([command, ...args].join(' '));
                if (command === 'CAPABILITY') {
                    socket.write('* CAPABILITY ' + capabilities + CRLF + tag + ' OK CAPABILITY completed' + CRLF);
                } else if (command === 'ID') {
                    socket.write('* ID NIL' + CRLF + tag + ' OK ID completed' + CRLF);
                } else if (command === 'AUTHENTICATE') {
                    const mechanism = (args[0] ?? '').toUpperCase();
                    if (args[1]) {
                        sasl(tag, mechanism, args[1]);
                    } else {
                        pendingAuth = { tag, mechanism };
                        socket.write('+ ' + CRLF);
                    }
                } else if (command === 'LOGIN') {
                    if (capabilities.includes('LOGINDISABLED')) {
                        socket.write(tag + ' NO LOGIN disabled' + CRLF);
                    } else {
                        const user = unquote(args[0] ?? '');
                        login(tag, user, accounts[user]?.password === unquote(args[1] ?? ''));
                    }
                } else if (command === 'NAMESPACE') {
                    socket.write('* NAMESPACE (("" "/")) NIL NIL' + CRLF + tag + ' OK NAMESPACE completed' + CRLF);
                } else if (command === 'SELECT' || command === 'EXAMINE') {
                    const mailbox = unquote(args[0] ?? '');
                    if (!mailboxes.includes(mailbox)) {
                        socket.write(tag + ' NO [NONEXISTENT] Mailbox does not exist' + CRLF);
                        continue;
                    }
                    socket.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)' + CRLF +
                        '* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Flags' + CRLF +
                        '* ' + exists + ' EXISTS' + CRLF + '* 0 RECENT' + CRLF +
                        '* OK [UIDVALIDITY 1] UIDs valid' + CRLF + '* OK [UIDNEXT ' + (exists + 1) + '] Next' + CRLF +
                        tag + ' OK [READ-WRITE] SELECT completed' + CRLF);
                } else if (command === 'IDLE') {
                    idling.set(socket, tag);
                    socket.write('+ idling' + CRLF);
                } else if (command === 'LOGOUT') {
                    socket.end('* BYE logging out' + CRLF + tag + ' OK LOGOUT completed' + CRLF);
                } else {
                    socket.write(tag + ' OK ' + command + ' completed' + CRLF);
                }
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => {
            resolve({
                port: (server.address() as AddressInfo).port,
                commands,
                newMail: () => {
                    exists += 1;
                    for (const socket of idling.keys()) {
                        socket.write('* ' + exists + ' EXISTS' + CRLF);
                    }
                },
                dropConnections: () => sockets.forEach(s => s.destroy()),
                stop: () => {
                    sockets.forEach(s => s.destroy());
                    return new Promise(done => server.close(() => done()));
                },
                connections: () => sockets.size,
            });
        });
    });
}
