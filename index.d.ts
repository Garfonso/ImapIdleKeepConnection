import { EventEmitter } from 'events';
import Connection = require('node-imap');

declare module 'imap-idle-keep-connection' {
    interface LogMethods {
        error: (...msgs: any[]) => void;
        debug: (...msgs: any[]) => void;
        info: (...msgs: any[]) => void;
    }

    interface ImapIdleConnectionParams {
        name: string;
        user: string;
        password?: string;
        xoauth2?: string;
        host: string;
        port: number;
        tls: boolean;
        mailbox?: string;
        log?: (...msgs: any[]) => void;
        debug?: (...msgs: any[]) => void;
        error?: (...msgs: any[]) => void;
        interval?: number;
        idleInterval?: number;
        forceNoop?: boolean;
    }

    class ImapIdleConnectionAndEvent extends EventEmitter {
        name: string;
        connecting: boolean;
        active: boolean;
        intervalHandler: NodeJS.Timeout;
        disconnects: number;
        numMailRuns: number;
        noReconnectBecauseOfAuth: boolean;
        retriesSinceLastSuccess: number;
        timeoutHandler: NodeJS.Timeout;
        mailbox: string;
        log: LogMethods;
        imap: Connection;

        constructor(params: ImapIdleConnectionParams);

        reconnect(funcName: string): void;
        onOpenBox(err: Error, box: any): void;
        onReady(): void;
        onMail(numNewMsgs: number, noSender?: boolean): void;
        onError(err: Error): void;
        onClose(err: Error): void;
        onEnd(err: Error): void;
        endWatch(): void;
        getStatus(): string;
    }

    export = ImapIdleConnectionAndEvent;
}