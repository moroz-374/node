import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { parseNodePayloadFromConfigService } from '@common/utils/decode-node-payload';

export const configSchema = z
    .object({
        NODE_PORT: z.string().transform((port) => {
            return parseInt(port, 10);
        }),
        SECRET_KEY: z.string(),
        JWT_PUBLIC_KEY: z.string().optional(),
        DISABLE_HASHED_SET_CHECK: z
            .string()
            .default('false')
            .transform((val) => val === 'true'),
        XTLS_API_PORT: z.string().transform((port) => {
            return parseInt(port, 10);
        }),
        XRAY_ACCESS_LOG_PATH: z.string().default('/var/log/xray/access.log'),
        TRAFFIC_AUDIT_BACKEND_URL: z.string().default(''),
        TRAFFIC_AUDIT_INGEST_TOKEN: z.string().default(''),
        TRAFFIC_AUDIT_NODE_UUID: z.string().default(''),
        TRAFFIC_AUDIT_FLUSH_INTERVAL_MS: z
            .string()
            .default('5000')
            .transform((value) => parseInt(value, 10))
            .pipe(z.number().int().positive()),
        TRAFFIC_AUDIT_QUEUE_MAX_SIZE: z
            .string()
            .default('20000')
            .transform((value) => parseInt(value, 10))
            .pipe(z.number().int().positive()),
        TRAFFIC_AUDIT_REQUEST_TIMEOUT_MS: z
            .string()
            .default('10000')
            .transform((value) => parseInt(value, 10))
            .pipe(z.number().int().positive()),
        TRAFFIC_AUDIT_BACKOFF_INITIAL_MS: z
            .string()
            .default('1000')
            .transform((value) => parseInt(value, 10))
            .pipe(z.number().int().positive()),
        TRAFFIC_AUDIT_BACKOFF_MAX_MS: z
            .string()
            .default('60000')
            .transform((value) => parseInt(value, 10))
            .pipe(z.number().int().positive()),
        INTERNAL_REST_TOKEN: z.string(),
        SUPERVISORD_USER: z.string(),
        SUPERVISORD_PASSWORD: z.string(),
        INTERNAL_SOCKET_PATH: z.string(),
        SUPERVISORD_SOCKET_PATH: z.string(),
        SUPERVISORD_PID_PATH: z.string(),
    })
    .superRefine((data, ctx) => {
        if (data.SECRET_KEY) {
            try {
                const parsed = parseNodePayloadFromConfigService(data.SECRET_KEY);
                data.JWT_PUBLIC_KEY = parsed.jwtPublicKey;
            } catch {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid SECRET_KEY payload',
                });
            }
        }
    });

export type ConfigSchema = z.infer<typeof configSchema>;
export class Env extends createZodDto(configSchema) {}
