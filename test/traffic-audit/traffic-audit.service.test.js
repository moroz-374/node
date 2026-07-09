const assert = require('node:assert/strict');
const { appendFile, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
    TrafficAuditService,
} = require('../../dist/src/modules/traffic-audit/traffic-audit.service');

const FIRST_LINE =
    '2026/06/28 10:00:00 198.51.100.10:1000 accepted tcp:first.example:443 [in -> direct] email: first-user\n';
const SECOND_LINE =
    '2026/06/28 10:00:01 198.51.100.10:1001 accepted udp:second.example:53 [in -> direct] email: second-user\n';

test('bounds the in-memory queue by dropping the oldest events', async () => {
    const fixture = await createFixture({ TRAFFIC_AUDIT_QUEUE_MAX_SIZE: 1 });

    try {
        await appendFile(fixture.logPath, FIRST_LINE + SECOND_LINE);
        await fixture.service.scheduleRead();

        assert.equal(fixture.service.queue.length, 1);
        assert.equal(fixture.service.queue[0].clientIdentifier, 'second-user');
    } finally {
        global.fetch = async () => ({ ok: true, status: 200 });
        await fixture.dispose();
    }
});

test('reads the old inode to the end before switching to a rotated log', async () => {
    const fixture = await createFixture();

    try {
        await appendFile(fixture.logPath, FIRST_LINE);
        await rename(fixture.logPath, `${fixture.logPath}.1`);
        await writeFile(fixture.logPath, SECOND_LINE);

        await fixture.service.scheduleRead();

        assert.deepEqual(
            fixture.service.queue.map((event) => event.clientIdentifier),
            ['first-user', 'second-user'],
        );
    } finally {
        global.fetch = async () => ({ ok: true, status: 200 });
        await fixture.dispose();
    }
});

test('restores a failed batch and suppresses retries until backoff expires', async () => {
    const fixture = await createFixture();
    let requestCount = 0;

    try {
        await appendFile(fixture.logPath, FIRST_LINE);
        await fixture.service.scheduleRead();

        global.fetch = async () => {
            requestCount += 1;

            return { ok: false, status: 503 };
        };

        assert.equal(await fixture.service.flush(), false);
        assert.equal(fixture.service.queue.length, 1);
        assert.equal(await fixture.service.flush(), false);
        assert.equal(requestCount, 1);

        fixture.service.nextFlushAt = 0;
        global.fetch = async () => {
            requestCount += 1;

            return { ok: true, status: 200 };
        };

        assert.equal(await fixture.service.flush(), true);
        assert.equal(fixture.service.queue.length, 0);
        assert.equal(requestCount, 2);
    } finally {
        await fixture.dispose();
    }
});

test('reads pending log data and flushes it during shutdown', async () => {
    const fixture = await createFixture();
    const payloads = [];

    try {
        global.fetch = async (_url, options) => {
            payloads.push(JSON.parse(options.body));

            return { ok: true, status: 200 };
        };

        await appendFile(fixture.logPath, FIRST_LINE);
        await fixture.service.onModuleDestroy();
        fixture.disposed = true;

        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].schemaVersion, 2);
        assert.equal(payloads[0].events[0].clientIdentifier, 'first-user');
        assert.equal('nodeUuid' in payloads[0], false);
        assert.deepEqual(payloads[0].metrics, {
            queueDepth: 0,
            droppedEventsTotal: 0,
            retryAttemptsTotal: 0,
            lastSuccessfulDeliveryAt: null,
        });
        assert.equal(fixture.service.queue.length, 0);
    } finally {
        await fixture.dispose();
    }
});

test('sends schema version 2 with extended parser fields', async () => {
    const fixture = await createFixture();
    const payloads = [];

    try {
        global.fetch = async (_url, options) => {
            payloads.push(JSON.parse(options.body));
            return { ok: true, status: 200 };
        };

        await appendFile(
            fixture.logPath,
            '2026/07/06 12:00:00.000001 from 198.51.100.10:50000 accepted tcp:example.com:443 [vless-in >> direct] email: audit-user original: tcp:203.0.113.20:443 sniffed: tls\n',
        );
        await fixture.service.scheduleRead();
        await fixture.service.flush();

        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].schemaVersion, 2);
        assert.equal(payloads[0].events[0].originalDestination, '203.0.113.20');
        assert.equal(payloads[0].events[0].originalDestinationType, 'IPV4');
        assert.equal(payloads[0].events[0].originalNetwork, 'tcp');
        assert.equal(payloads[0].events[0].originalPort, 443);
        assert.equal(payloads[0].events[0].sniffedProtocol, 'tls');
    } finally {
        await fixture.dispose();
    }
});

test('starts at the end of an existing log and only sends newly appended events', async () => {
    const fixture = await createFixture({}, FIRST_LINE);
    const payloads = [];

    try {
        global.fetch = async (_url, options) => {
            payloads.push(JSON.parse(options.body));
            return { ok: true, status: 200 };
        };

        await fixture.service.scheduleRead();
        assert.equal(fixture.service.queue.length, 0);

        await appendFile(fixture.logPath, SECOND_LINE);
        await fixture.service.scheduleRead();
        await fixture.service.flush();

        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].events[0].clientIdentifier, 'second-user');
    } finally {
        await fixture.dispose();
    }
});

async function createFixture(overrides = {}, initialContent = '') {
    const directory = await mkdtemp(join(tmpdir(), 'traffic-audit-'));
    const logPath = join(directory, 'access.log');
    await writeFile(logPath, initialContent);

    const config = {
        TRAFFIC_AUDIT_BACKEND_URL: 'http://backend.test',
        TRAFFIC_AUDIT_CREDENTIAL: `${'a'.repeat(24)}.${'b'.repeat(43)}`,
        XRAY_ACCESS_LOG_PATH: logPath,
        TRAFFIC_AUDIT_FLUSH_INTERVAL_MS: 60_000,
        TRAFFIC_AUDIT_QUEUE_MAX_SIZE: 20_000,
        TRAFFIC_AUDIT_REQUEST_TIMEOUT_MS: 1_000,
        TRAFFIC_AUDIT_BACKOFF_INITIAL_MS: 1_000,
        TRAFFIC_AUDIT_BACKOFF_MAX_MS: 60_000,
        ...overrides,
    };
    const service = new TrafficAuditService({
        getOrThrow(key) {
            assert.notEqual(config[key], undefined, `missing test config: ${key}`);

            return config[key];
        },
    });
    await service.onModuleInit();

    return {
        directory,
        disposed: false,
        logPath,
        service,
        async dispose() {
            if (!this.disposed) {
                await service.onModuleDestroy();
                this.disposed = true;
            }

            await rm(directory, { force: true, recursive: true });
        },
    };
}
