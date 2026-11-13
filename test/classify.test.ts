import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, describeError, formatDuration, retryDelay } from '../src/index.ts';

const error = (message: string, props: Record<string, unknown> = {}) => Object.assign(new Error(message), props);

describe('classifyError', () => {
    it('recognises network errors by code', () => {
        for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'CONNECT_TIMEOUT', 'NoConnection']) {
            assert.equal(classifyError(error('x', { code })), 'network', code);
        }
        assert.equal(classifyError(error('wrapped', { _err: error('x', { code: 'ECONNRESET' }) })), 'network');
    });

    it('recognises rejected credentials, but not temporary server problems', () => {
        assert.equal(classifyError(error('Authentication failed', { authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' })), 'auth');
        assert.equal(classifyError(error('Authentication failed', { authenticationFailed: true })), 'auth');
        assert.equal(classifyError(error('Authentication failed', { authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' })), 'other');
        assert.equal(classifyError(error('x', { serverResponseCode: 'serverbug' })), 'other');
    });

    it('recognises throttling, missing mailboxes and the rest', () => {
        assert.equal(classifyError(error('x', { code: 'ETHROTTLE' })), 'throttle');
        assert.equal(classifyError(error('x', { mailboxMissing: true })), 'mailbox');
        assert.equal(classifyError(error('x', { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })), 'other');
        assert.equal(classifyError(undefined), 'other');
        assert.equal(classifyError('text'), 'other');
    });
});

describe('describeError', () => {
    it('uses the server response instead of generic messages', () => {
        assert.equal(describeError(error('Command failed', { responseText: 'Invalid credentials', serverResponseCode: 'AUTHENTICATIONFAILED' })),
            'Invalid credentials [AUTHENTICATIONFAILED]');
        assert.equal(describeError(error('Select failed', { responseText: 'No such mailbox' })), 'Select failed: No such mailbox');
    });

    it('adds the code once and shortens openssl messages', () => {
        assert.equal(describeError(error('getaddrinfo ENOTFOUND x', { code: 'ENOTFOUND' })), 'getaddrinfo ENOTFOUND x');
        assert.equal(describeError(error('Timeout', { code: 'CONNECT_TIMEOUT' })), 'Timeout (CONNECT_TIMEOUT)');
        assert.equal(describeError(error('00D9BA87547F0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:ssl/record/methods/tlsany_meth.c:77:\n',
            { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })), 'TLS error: wrong version number (ERR_SSL_WRONG_VERSION_NUMBER)');
        assert.equal(describeError('plain'), 'plain');
    });
});

describe('retryDelay / formatDuration', () => {
    it('repeats the last delay', () => {
        assert.equal(retryDelay([1, 2, 3], 1), 1);
        assert.equal(retryDelay([1, 2, 3], 3), 3);
        assert.equal(retryDelay([1, 2, 3], 30), 3);
        assert.equal(retryDelay([], 3), 0);
    });

    it('formats durations', () => {
        assert.deepEqual([0, 250, 30000, 5 * 60000, 90 * 60000].map(formatDuration), ['0s', '250ms', '30s', '5min', '1.5h']);
    });
});
