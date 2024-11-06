# ImapIdleKeepConnection
 use node-imap to connect to an imap server and handle all errors. Only emit mail event

Usage example: 

```javascript

const ImapIdleKeepConnection = require('imap-idle-keep-connection');

const imapConnection = new ImapIdleKeepConnection({
    user: MailUser,
    password: MailPassword,
    xoauth2: token, //alternative: supply xoauth2 token instead of password. You'll have to obtain the token yourself. 
    host: MailServer,
    port: MailServerPort,
    tls: true, //use TLS or not
    
    //optional log methods. By default errors are logged to console and nothing else:
    log: () => {},
    debug: () => {},
    error: () => {},
    
    // keepalive:
    interval: 10000, //default 10000ms - NOOPs are send & idleInterval is checked,
    idleInterval: 120000, //default 120000ms - interval at which IDLE command is resend
    forceNoop: false //default: false - force use of NOOP keepalice on servers also support IDLE
});

imapConnection.on('mail', (imap, numNewMessages) => {
    console.log('yay, got new mail!');
    //use imap, which is a node-imap instance to maybe receive mail.
});

imapConnection.on('need-authentication', () => {
    console.log('Authentication failed. Won\'t retry. Get new token (maybe, if oauth) and start again.');
    //need to create new object with new credentials in this case!
    imapConnection.endWatch();
});

imapConnection.on('error', error => {
    console.log('Something went horribly wrong...', error);
});
```


