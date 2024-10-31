const ImapIdleConnectionAndEvent = require('./index.js');

const params = {
    user: 'USERNAME',
    xoauth2: 'TOKEN',
    host: 'imap-mail.outlook.com',
    port: 993,
    mailbox: 'INBOX',
    tls: true,
    log: console.log,
    debug: console.log,
    error: console.error
}

params.imapWatcher = new ImapIdleConnectionAndEvent(params);
params.imapWatcher.on('mail', mail => {
    console.log('new Mail:', mail);
});
params.imapWatcher.on('ready', args => {
    console.log('ready.');
});

console.log('done');