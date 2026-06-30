const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TZ = 'UTC';

const {
    parseTrafficAuditAccessLogLine,
} = require('../../dist/src/modules/traffic-audit/traffic-audit-access-log.parser');

test('parses and normalizes a domain destination', () => {
    const event = parseTrafficAuditAccessLogLine(
        '2026/06/27 15:20:30.123 198.51.100.10:54321 accepted tcp:Example.COM.:443 [vless-in -> direct] email: audit-user',
    );

    assert.deepEqual(event, {
        clientIdentifier: 'audit-user',
        destination: 'example.com',
        destinationType: 'DOMAIN',
        network: 'tcp',
        port: 443,
        requestedAt: '2026-06-27T15:20:30.123Z',
    });
});

test('parses the current Xray access-log format with the from prefix', () => {
    const event = parseTrafficAuditAccessLogLine(
        '2026/06/29 11:24:18.480791 from 172.18.0.10:60858 accepted tcp:traffic-audit-target:8080 [vless-in >> direct] email: audit-enabled',
    );

    assert.equal(event.clientIdentifier, 'audit-enabled');
    assert.equal(event.destination, 'traffic-audit-target');
    assert.equal(event.network, 'tcp');
    assert.equal(event.port, 8080);
});

test('parses bracketed IPv6 UDP destinations', () => {
    const event = parseTrafficAuditAccessLogLine(
        '2026/06/27 15:20:31 198.51.100.10:54321 accepted udp:[2001:db8::1]:53 [vless-in -> direct] email: user@example.com',
    );

    assert.equal(event.destination, '2001:db8::1');
    assert.equal(event.destinationType, 'IPV6');
    assert.equal(event.network, 'udp');
    assert.equal(event.port, 53);
});

test('ignores entries that cannot be attributed to a user', () => {
    assert.equal(
        parseTrafficAuditAccessLogLine(
            '2026/06/27 15:20:32 198.51.100.10:54321 accepted tcp:example.com:443 [vless-in -> direct]',
        ),
        null,
    );
});

test('ignores rejected and malformed entries', () => {
    assert.equal(
        parseTrafficAuditAccessLogLine(
            '2026/06/27 15:20:33 198.51.100.10:54321 rejected tcp:example.com:443 [vless-in] email: audit-user',
        ),
        null,
    );
    assert.equal(parseTrafficAuditAccessLogLine('not an xray access log line'), null);
});
