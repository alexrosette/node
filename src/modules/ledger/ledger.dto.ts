import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class PutLedgerConfigRequestDto extends createZodDto(
    z.object({
        config: z.record(z.string(), z.unknown()),
        baseHash: z.string().optional(),
    }),
) {}

export class LedgerRestartRequestDto extends createZodDto(
    z
        .object({
            reason: z.string().max(500).optional(),
        })
        .optional()
        .default({}),
) {}
