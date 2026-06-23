import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TrafficAuditService implements OnModuleInit {
    private readonly logger = new Logger(TrafficAuditService.name);

    constructor(private readonly configService: ConfigService) {}

    public onModuleInit(): void {
        const backendUrl = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_BACKEND_URL');
        const token = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_INGEST_TOKEN');
        const nodeUuid = this.configService.getOrThrow<string>('TRAFFIC_AUDIT_NODE_UUID');

        if (!backendUrl || !token || !nodeUuid) {
            this.logger.log(
                'Traffic audit sender disabled: backend URL, ingest token, or node UUID is not configured',
            );

            return;
        }

        this.logger.log('Traffic audit sender enabled');
    }
}