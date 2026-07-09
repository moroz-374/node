import type { FileHandle } from 'node:fs/promises';

import { open, stat } from 'node:fs/promises';
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

interface FileIdentity {
    device: number;
    inode: number;
}

const INGEST_BATCH_SIZE = 5_000;
const READ_CHUNK_SIZE = 64 * 1_024;

@Injectable()
export class TrafficAuditService implements OnModuleDestroy, OnModuleInit {
    private readonly logger = new Logger(TrafficAuditService.name);

    private accessLogHandle: FileHandle | null = null;
    private accessLogIdentity: FileIdentity | null = null;
    private activeFlush: Promise<boolean> | null = null;
    private activeRead: Promise<void> | null = null;
    private backendUrl = '';
    private backoffInitialMs = 1_000;
    private backoffMaxMs = 60_000;
    private buffer = '';
    private cursor = 0;
    private enabled = false;
    private flushIntervalMs = 5_000;
    private flushTimer: NodeJS.Timeout | null = null;
    private hasCompletedInitialOpen = false;
    private nextFlushAt = 0;
    private pollTimer: NodeJS.Timeout | null = null;
    private queueMaxSize = 20_000;
    private readonly queue: TrafficAuditPayloadEvent[] = [];
    private requestTimeoutMs = 10_000;
    private retryAttempt = 0;
    private shuttingDown = false;
    private credential = '';
    private droppedEventsTotal = 0;
    private retryAttemptsTotal = 0;
    private lastSuccessfulDeliveryAt: number | null = null;
    private accessLogPath = '';

    constructor(private readonly configService: ConfigService) {}

    public async onModuleInit(): Promise<void> {
        this.backendUrl = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_BACKEND_URL');
        this.credential = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_CREDENTIAL');
        this.accessLogPath = this.configService.getOrThrow<string>('XRAY_ACCESS_LOG_PATH');
        this.flushIntervalMs = this.configService.getOrThrow<number>(
            'TRAFFIC_AUDIT_FLUSH_INTERVAL_MS',
        );
        this.queueMaxSize = this.configService.getOrThrow<number>('TRAFFIC_AUDIT_QUEUE_MAX_SIZE');
        this.requestTimeoutMs = this.configService.getOrThrow<number>(
            'TRAFFIC_AUDIT_REQUEST_TIMEOUT_MS',
        );
        this.backoffInitialMs = this.configService.getOrThrow<number>(
            'TRAFFIC_AUDIT_BACKOFF_INITIAL_MS',
        );
        this.backoffMaxMs = this.configService.getOrThrow<number>('TRAFFIC_AUDIT_BACKOFF_MAX_MS');

        if (!this.backendUrl || !this.credential) {
            this.logger.log(
                'Traffic audit sender disabled: backend URL or credential is not configured',
            );

            return;
        }

        this.enabled = true;
        await this.openAccessLog(true);

        this.pollTimer = setInterval(() => {
            void this.scheduleRead();
        }, 1_000);

        this.flushTimer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);

        this.logger.log(`Traffic audit sender enabled. Access log: ${this.accessLogPath}`);
    }

    public async onModuleDestroy(): Promise<void> {
        if (!this.enabled) {
            return;
        }

        this.shuttingDown = true;

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }

        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }

        if (this.activeRead) {
            await this.activeRead;
        }

        await this.scheduleRead();

        if (this.activeFlush) {
            await this.activeFlush;
        }

        while (this.queue.length > 0) {
            const sent = await this.flush(true);

            if (!sent) {
                break;
            }
        }

        await this.closeAccessLog();

        if (this.queue.length > 0) {
            this.logger.warn(
                `Traffic audit shutdown completed with ${this.queue.length} unsent events`,
            );
        }
    }

    private async scheduleRead(): Promise<void> {
        if (this.activeRead) {
            return this.activeRead;
        }

        this.activeRead = this.readNewLines().finally(() => {
            this.activeRead = null;
        });

        return this.activeRead;
    }

    private async readNewLines(): Promise<void> {
        if (!this.accessLogHandle) {
            await this.openAccessLog(false);

            if (!this.accessLogHandle) {
                return;
            }
        }

        let pathStat;

        try {
            pathStat = await stat(this.accessLogPath);
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                this.logger.warn(`Cannot stat traffic audit access log: ${getErrorMessage(error)}`);
            }

            return;
        }

        const pathIdentity = getFileIdentity(pathStat);

        if (!isSameFile(this.accessLogIdentity, pathIdentity)) {
            await this.readCurrentFileToEnd();
            await this.closeAccessLog();
            this.discardPartialLine('log rotation');
            await this.openAccessLog(false);
        }

        await this.readCurrentFileToEnd();
    }

    private async readCurrentFileToEnd(): Promise<void> {
        const handle = this.accessLogHandle;

        if (!handle) {
            return;
        }

        const handleStat = await handle.stat();

        if (handleStat.size < this.cursor) {
            this.cursor = 0;
            this.discardPartialLine('log truncation');
        }

        const targetSize = handleStat.size;

        while (this.cursor < targetSize) {
            const bytesToRead = Math.min(READ_CHUNK_SIZE, targetSize - this.cursor);
            const chunk = Buffer.allocUnsafe(bytesToRead);
            const { bytesRead } = await handle.read(chunk, 0, bytesToRead, this.cursor);

            if (bytesRead === 0) {
                break;
            }

            this.cursor += bytesRead;
            this.processChunk(chunk.toString('utf8', 0, bytesRead));
        }
    }

    private processChunk(chunk: string): void {
        const lines = (this.buffer + chunk).split(/\r?\n/);
        this.buffer = lines.pop() || '';
        let droppedEvents = 0;

        for (const line of lines) {
            const parsed = parseTrafficAuditAccessLogLine(line);

            if (!parsed) {
                continue;
            }

            droppedEvents += this.enqueue({
                ...parsed,
                eventId: randomUUID(),
            });
        }

        if (droppedEvents > 0) {
            this.droppedEventsTotal += droppedEvents;
            this.logger.warn(
                `Traffic audit queue limit (${this.queueMaxSize}) reached; dropped ${droppedEvents} oldest events`,
            );
        }

        if (this.queue.length >= 500 && !this.shuttingDown) {
            void this.flush();
        }
    }

    private enqueue(event: TrafficAuditPayloadEvent): number {
        let droppedEvents = 0;

        if (this.queue.length >= this.queueMaxSize) {
            this.queue.shift();
            droppedEvents = 1;
        }

        this.queue.push(event);

        return droppedEvents;
    }

    private async flush(ignoreBackoff = false): Promise<boolean> {
        if (this.activeFlush) {
            return this.activeFlush;
        }

        if (this.queue.length === 0 || (!ignoreBackoff && Date.now() < this.nextFlushAt)) {
            return false;
        }

        this.activeFlush = this.sendNextBatch().finally(() => {
            this.activeFlush = null;
        });

        return this.activeFlush;
    }

    private async sendNextBatch(): Promise<boolean> {
        const events = this.queue.splice(0, INGEST_BATCH_SIZE);

        try {
            const response = await fetch(`${this.backendUrl}/api/monitoring/ingest`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.credential}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    schemaVersion: 2,
                    events,
                    metrics: {
                        queueDepth: this.queue.length,
                        droppedEventsTotal: this.droppedEventsTotal,
                        retryAttemptsTotal: this.retryAttemptsTotal,
                        lastSuccessfulDeliveryAt: this.lastSuccessfulDeliveryAt,
                    },
                }),
                signal: AbortSignal.timeout(this.requestTimeoutMs),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            this.retryAttempt = 0;
            this.nextFlushAt = 0;
            this.lastSuccessfulDeliveryAt = Date.now();

            return true;
        } catch (error) {
            this.queue.unshift(...events);
            this.retryAttempt += 1;
            this.retryAttemptsTotal += 1;

            const delay = Math.min(
                this.backoffInitialMs * 2 ** (this.retryAttempt - 1),
                this.backoffMaxMs,
            );
            this.nextFlushAt = Date.now() + delay;

            this.logger.warn(
                `Traffic audit ingest failed; retrying in ${delay}ms: ${getErrorMessage(error)}`,
            );

            return false;
        }
    }

    private async openAccessLog(startAtEnd: boolean): Promise<void> {
        try {
            const handle = await open(this.accessLogPath, 'r');
            const fileStat = await handle.stat();

            this.accessLogHandle = handle;
            this.accessLogIdentity = getFileIdentity(fileStat);
            this.cursor = startAtEnd && !this.hasCompletedInitialOpen ? fileStat.size : 0;
            this.hasCompletedInitialOpen = true;
        } catch (error) {
            this.hasCompletedInitialOpen = true;

            if (!isFileNotFoundError(error)) {
                this.logger.warn(`Cannot open traffic audit access log: ${getErrorMessage(error)}`);
            }
        }
    }

    private async closeAccessLog(): Promise<void> {
        const handle = this.accessLogHandle;

        this.accessLogHandle = null;
        this.accessLogIdentity = null;
        this.cursor = 0;

        if (handle) {
            await handle.close();
        }
    }

    private discardPartialLine(reason: string): void {
        if (this.buffer) {
            this.logger.warn(`Discarded partial traffic audit log line after ${reason}`);
            this.buffer = '';
        }
    }
}

function getFileIdentity(fileStat: { dev: number; ino: number }): FileIdentity {
    return {
        device: fileStat.dev,
        inode: fileStat.ino,
    };
}

function isSameFile(left: FileIdentity | null, right: FileIdentity): boolean {
    return left !== null && left.device === right.device && left.inode === right.inode;
}

function isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
