# imap-idle-keep-connection

Keep an IMAP IDLE connection alive, whatever happens: reconnects with backoff and tells apart
why it failed (network down, credentials rejected, token missing, server throttling, ...).
Gets fresh credentials for every attempt, so OAuth tokens never go stale. Never gives up,
`stop()` ends it.

Built on [imapflow](https://github.com/postalsys/imapflow). Node.js >= 20.19 (ESM, `require()`
works too).

```ts
import { KeepConnection } from 'imap-idle-keep-connection';

const connection = new KeepConnection({
    host: 'outlook.office365.com',
    // static: { user, password } or a callback, called before every attempt:
    credentials: async () => ({ user: 'me@example.org', accessToken: await getToken() }),
    mailbox: 'INBOX',          // default
    logger: console,           // debug/info/error, default: only errors to console
});

connection.on('ready', async client => {
    // connected (again): check for mails you may have missed. client is an ImapFlow instance.
});
connection.on('mail', async ({ count, prevCount }) => {
    const uids = await connection.withMailbox(client => client.search({ seen: false }, { uid: true }));
});
connection.on('failure', ({ kind, error, failures, retryIn }) => {
    // optional, for status displays. Failures are logged already.
});

connection.start();
// later
await connection.stop();
```

## Failures

| kind | when | next attempt |
|---|---|---|
| `network` | DNS, connection refused, timeouts, connection dropped | 10s, 30s, 1min, 2min, then every 5min, forever |
| `auth` | server rejected the credentials | right away with new credentials (callback only), then 5min, 10min, 20min, ... up to 6h |
| `credentials` | credentials callback failed, server is reachable | 1min, 5min, 15min, 30min, 1h |
| `mailbox` | mailbox does not exist | 5min, 15min, 30min, 1h |
| `throttle` | server asked to slow down | as the server says |
| `other` | protocol/TLS errors, temporary server errors (`[UNAVAILABLE]`, ...) | 30s, 1min, ... up to 30min |

If the credentials callback fails, a TCP connect to the server decides whether the network is
down (`network`) or the token is the problem (`credentials`). Delays can be changed with the
`delays` option. A connection that worked for at least a minute and is then lost reconnects
after 10s, without counting as failure.

Logging is quiet: one line per problem, repeated network/other failures only on debug level,
one error line if it still fails after an hour and one info line when connected again.
`trace: true` logs imapflow's messages on debug level (credentials are not logged).

## API

- `start()`, `stop(): Promise<void>`
- `retryNow()`: skip the wait, e.g. when another connection reports that the network is back.
- `client`: the `ImapFlow` instance while connected, the mailbox is selected.
- `withMailbox(fn)`: run `fn(client)` with the mailbox locked.
- `state`, `status`: `{ state, since, failures, failureKind, lastError, nextAttempt, connects, mails }`.
- events `ready(client)`, `mail({ count, prevCount })`, `failure({ kind, error, failures, retryIn, lost })`.
- options: `host`, `port` (993/143), `secure` (default true), `mailbox`, `credentials`, `logger`,
  `trace`, `maxIdleTime` (restart IDLE, default 2min), `delays`, `imapOptions` (passed to imapflow).

Types of imapflow (`ImapFlow`, `SearchObject`, `FetchMessageObject`, ...) are re-exported.

## Migrating from 0.x

0.x used node-imap and auto-connected in the constructor.

- `new ImapIdleKeepConnection({ user, password | xoauth2, host, port, tls, mailbox, log, debug, error })`
  → `new KeepConnection({ host, port, secure, mailbox, credentials: { user, password } | () => ({ user, accessToken }), logger })`
  and `start()`.
- `ready(imap)` / `mail(imap, n)` → `ready(client)` / `mail({ count, prevCount })`, the client is imapflow.
- `need-authentication` and `error` (gave up) are gone: it retries itself, see `failure`.
- `endWatch()` → `stop()`, `getStatus()` → `status`.

## Development

```sh
npm ci
npm test          # lint, typecheck, tests (node:test, TypeScript runs directly)
npm run build     # dist/
npm run release   # @alcalzone/release-script, CI publishes with npm trusted publishing
```
