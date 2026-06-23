import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
    parseTrafficAuditAccessLogLine,
    TrafficAuditAccessLogEvent,
} from './traffic-audit-access-log.parser';

interface TrafficAuditPayloadEvent extends TrafficAuditAccessLogEvent {
    eventId: string;
}

@Injectable()
export class TrafficAuditService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TrafficAuditService.name);

    private buffer = '';
    private cursor = 0;
    private flushTimer: NodeJS.Timeout | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private readonly queue: TrafficAuditPayloadEvent[] = [];

    private backendUrl = '';
    private token = '';
    private nodeUuid = '';
    private accessLogPath = '';
    private flushIntervalMs = 5_000;

    constructor(private readonly configService: ConfigService) {}

    public onModuleInit(): void {
        this.backendUrl = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_BACKEND_URL');
        this.token = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_INGEST_TOKEN');
        this.nodeUuid = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_NODE_UUID');
        this.accessLogPath = this.configService.getOrThrow<string>('XRAY_ACCESS_LOG_PATH');
        this.flushIntervalMs = this.configService.getOrThrow<number>(
            'TRAFFIC_AUDIT_FLUSH_INTERVAL_MS',
        );

        if (!this.backendUrl || !this.token || !this.nodeUuid) {
            this.logger.log(
                'Traffic audit sender disabled: backend URL, ingest token, or node UUID is not configured',
            );

            return;
        }

        this.initializeCursor();

        this.pollTimer = setInterval(() => {
            void this.readNewLines();
        }, 1_000);

        this.flushTimer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);

        this.logger.log(`Traffic audit sender enabled. Access log: ${this.accessLogPath}`);
    }

    public onModuleDestroy(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }

        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
    }

    private initializeCursor(): void {
        if (!existsSync(this.accessLogPath)) {
            this.cursor = 0;

            this.logger.warn(`Traffic audit access log does not exist yet: ${this.accessLogPath}`);

            return;
        }

        this.cursor = statSync(this.accessLogPath).size;
    }

    private async readNewLines(): Promise<void> {
        if (!existsSync(this.accessLogPath)) {
            return;
        }

        const stat = statSync(this.accessLogPath);

        if (stat.size < this.cursor) {
            this.cursor = 0;
            this.buffer = '';
        }

        if (stat.size === this.cursor) {
            return;
        }

        const stream = createReadStream(this.accessLogPath, {
            start: this.cursor,
            end: stat.size - 1,
            encoding: 'utf8',
        });

        let chunk = '';

        for await (const data of stream) {
            chunk += data;
        }

        this.cursor = stat.size;

        const lines = (this.buffer + chunk).split(/\r?\n/);
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const parsed = parseTrafficAuditAccessLogLine(line);

            if (!parsed) {
                continue;
            }

            this.queue.push({
                ...parsed,
                eventId: randomUUID(),
            });
        }

        if (this.queue.length >= 500) {
            void this.flush();
        }
    }

    private async flush(): Promise<void> {
        if (this.isFlushing || this.queue.length === 0) {
            return;
        }

        this.isFlushing = true;

        const events = this.queue.splice(0, 5_000);

        try {
            const response = await fetch(`${this.backendUrl}/api/monitoring/ingest`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    nodeUuid: this.nodeUuid,
                    events,
                }),
            });

            if (!response.ok) {
                this.queue.unshift(...events);

                this.logger.warn(`Traffic audit ingest failed with HTTP ${response.status}`);
            }
        } catch (error) {
            this.queue.unshift(...events);

            this.logger.warn(
                `Traffic audit ingest request failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } finally {
            this.isFlushing = false;
        }
    }
}
