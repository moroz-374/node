import { Module } from '@nestjs/common';

import { TrafficAuditService } from './traffic-audit.service';

@Module({
    providers: [TrafficAuditService],
})
export class TrafficAuditModule {}
