import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TrafficAuditService implements OnModuleInit {
    private readonly logger = new Logger(TrafficAuditService.name);

    constructor(private readonly configService: ConfigService) {}

    public onModuleInit(): void {
        const backendUrl = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_BACKEND_URL');
        const token = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_INGEST_TOKEN');

        if (!backendUrl || !token) {
            this.logger.log('Traffic audit sender disabled: backend URL or ingest token is not configured');

            return;
        }

        this.logger.log('Traffic audit sender enabled');
    }
}