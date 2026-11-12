const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const ImapIdleConnectionAndEvent = require('../index.js');

const CRLF = '\r\n';

// minimal IMAP server: LOGIN, SELECT and IDLE.
function startServer() {
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.write('* OK ready' + CRLF);
        let buffer = '';
        let idleTag;
        socket.on('data', data => {
            buffer += data.toString();
            let index;
            while ((index = buffer.indexOf(CRLF)) > -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (line === 'DONE') {
                    socket.write(idleTag + ' OK idle done' + CRLF);
                    continue;
                }
                const [tag, command] = line.split(' ');
                if (command === 'CAPABILITY') {
                    socket.write('* CAPABILITY IMAP4rev1 IDLE' + CRLF + tag + ' OK' + CRLF);
                } else if (command === 'SELECT') {
                    socket.write('* 1 EXISTS' + CRLF + '* OK [UIDVALIDITY 1] ok' + CRLF + tag + ' OK [READ-WRITE] selected' + CRLF);
                } else if (command === 'IDLE') {
                    idleTag = tag;
                    socket.write('+ idling' + CRLF);
                } else if (command === 'LOGOUT') {
                    socket.end('* BYE' + CRLF + tag + ' OK' + CRLF);
                } else {
                    socket.write(tag + ' OK' + CRLF);
                }
            }
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, port: server.address().port })));
}

describe('endWatch', () => {
    it('does not schedule a reconnect after the connection closed', async () => {
        const { server, sockets, port } = await startServer();
        const watcher = new ImapIdleConnectionAndEvent({
            user: 'u', password: 'p', host: '127.0.0.1', port, tls: false, mailbox: 'INBOX',
            log: () => {}, debug: () => {}, error: () => {},
        });
        try {
            await new Promise(resolve => watcher.once('box', resolve));
            const closed = new Promise(resolve => watcher.imap.once('close', resolve));
            watcher.endWatch();
            await closed;
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(watcher.timeoutHandler, false, 'no reconnect timer pending');
            assert.equal(watcher.ended, true);
        } finally {
            clearTimeout(watcher.timeoutHandler);
            sockets.forEach(s => s.destroy());
            await new Promise(resolve => server.close(resolve));
        }
    });
});
