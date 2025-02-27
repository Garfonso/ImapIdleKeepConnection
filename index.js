/*jslint node: true, es6: true */
/*jshint esversion: 6*/

/**
 * Created by garfo on 20.10.2016.
 */

const Imap = require('node-imap'); //use our own imap. But we keep npm imap installed to have the dependencies installed, too. Check if this works.
const EventEmitter = require('events').EventEmitter;
const { Buffer } = require('node:buffer');

const _build_XOAuth2_token = (user='', access_token='') => Buffer
    .from([`user=${user}`, `auth=Bearer ${access_token}`, '', '']
        .join('\x01'), 'utf-8')
    .toString('base64');

class ImapIdleConnectionAndEvent extends EventEmitter {
    name = '';
    connecting = true;
    active = false;
    intervalHandler;
    disconnects = 0;
    numMailRuns = 0;
    noReconnectBecauseOfAuth = false; //prevent all reconnects if this is true -> need to create a new object with new credentials.
    retriesSinceLastSuccess = 0;
    timeoutHandler;
    mailbox = 'INBOX';

    log = {
        error: (...msgs) => { console.error(msgs); },
        debug: () => { },
        info: () => { }
    };

    imap;

    reconnect(funcName) {
        if (this.timeoutHandler) {
            clearTimeout(this.timeoutHandler);
            this.timeoutHandler = false;
        }
        if (this.noReconnectBecauseOfAuth) {
            this.log.info('Will not reconnect, because had auth error, was requested by ' + funcName);
            return;
        }
        this.timeoutHandler = setTimeout(() => {
            if (this.imap.state !== 'connected' && this.imap.state !== 'authenticated' && !this.connecting) {
                if (this.retriesSinceLastSuccess < 10) {
                    this.log.error('Reconnecting -', funcName);
                    this.log.error('Imap state:', this.imap.state, 'active flag:', this.active, 'connecting flag:', this.connecting);
                    this.connecting = true;
                    this.imap.connect();
                    this.disconnects += 1;
                    this.retriesSinceLastSuccess += 1;
                } else {
                    this.log.error('Already tried to reconnect', this.retriesSinceLastSuccess, 'times. Will stop now to avoid bans. Please check credentials.');
                    this.emit('error', new Error('too many retries... failing.'));
                }
            } else if (this.connecting) {
                this.log.debug('Already connecting -', funcName);
                this.log.debug('Imap state:', this.imap.state, 'active flag:', this.active, 'connecting flag:', this.connecting);
            }
        }, Math.round(Math.random() * 30000) + 120000); //between 120s and 150s.
    }

    onOpenBox(err , box) {
        this.log.debug('onOpenBox');
        if (err) {
            this.log.error('Error in opening box:', err);
        } else {
            //params.debug("Box:", box);
            this.log.info('Idle at work now.');
        }
        this.emit('box', box);
    }

    onReady() {
        this.log.info('Successful connected & authenticated.');
        //open read only.
        this.retriesSinceLastSuccess = 0;
        this.imap.openBox(this.mailbox, false, (err, box) => this.onOpenBox(err, box));
        this.connecting = false;
        this.active = true;
        this.emit('ready', this.imap);
    }

    onMail(numNewMsgs, noSender = false) {
        this.log.info('new Mail');
        this.retriesSinceLastSuccess = 0;
        this.numMailRuns += 1;
        this.emit('mail', this.imap, numNewMsgs, noSender);
    }

    onError(err) {
        this.log.info('Have error: ', err);
        if (err) {
            this.log.info('Error from source:', err.source);
            if (err.source === 'authentication') {
                this.noReconnectBecauseOfAuth = true;
                this.emit('need-authentication', err);
                this.endWatch();
                return; //don't try to reconnect on authentication error.
            }
        }
        this.active = false;
        this.connecting = false;
        this.reconnect('Error');
    }

    onClose(err) {
        //Can this happen without error before?
        this.log.info('Have close, error: ', err);
        this.active = false;
        this.connecting = false;
        this.reconnect('Close');
    }

    onEnd(err) {
        this.log.info('Connection ended...');
        if (err) {
            this.log.info('Error:', err, 'From source:', err.source);
            if (err.source === 'authentication') {
                this.emit('need-authentication', err);
                return; //don't try to reconnect on authentication error.
            }
        }
        this.active = false;
        this.connecting = false;
        this.reconnect('End');
    }


    /**
     *
     * @param params: {
     *     name: name of the idle watcher, needs to be unique!
     *     user
     *     password
     *     xoauth2
     *     host
     *     port
     *     tls
     *     mailbox
     *
     *     log
     *     debug
     *     error
     *   }
     */
    constructor(params) {
        super();

        this.mailbox = params.mailbox;
        this.imap = new Imap({
            user: params.user,
            password: params.password,
            xoauth2: params.xoauth2 ? _build_XOAuth2_token(params.user, params.xoauth2) : undefined,
            host: params.host,
            port: params.port,
            tls: params.tls,

            //idle stuff:
            keepalive: {
                interval: params.interval || 10000, //default 10000ms - NOOPs are send & idleInterval is checked
                idleInterval: params.idleInterval || 120000, //default 300.000ms - interval at which IDLE command is resend - set to 2min on 12.12.2016
                // -> ca. 150.000ms seems to be necessary for outlook. So have this at 120s.
                // -> now very few disconnects.. let's see.
                // -> profihost sometimes "connection end" -> i.e. no error. Hm. Too many?
                forceNoop: params.forceNoop || false //default: false - force use of NOOP keepalice on servers also support IDLE
            }
        });

        this.imap.on('ready', this.onReady.bind(this));
        this.imap.on('mail', (numNewMessages, noSender) => this.onMail(numNewMessages, noSender));
        this.imap.on('error', this.onError.bind(this));
        this.imap.on('close', this.onClose.bind(this));
        this.imap.on('end', this.onEnd.bind(this));

        if (typeof params.log === 'function') {
            this.log.info = params.log;
        }
        if (typeof params.debug === 'function') {
            this.log.debug = params.debug;
        }
        if (typeof params.error === 'function') {
            this.log.error = params.error;
        }

        this.imap.connect();

        this.intervalHandler = setInterval(() => this.reconnect('triggered'), 300000); //timeout needs to be higher than the one in reconnect itself.
    }

    endWatch() {
        clearTimeout(this.timeoutHandler);
        clearInterval(this.intervalHandler);
        this.imap.end();
    }

    getStatus() {
        return this.imap.state + '\t#mailruns:\t' + this.numMailRuns + '\t#disconnects:\t' + this.disconnects + '\t#retriesSinceLastSuccess:\t' + this.retriesSinceLastSuccess + '\n';
    }
}

module.exports = ImapIdleConnectionAndEvent;