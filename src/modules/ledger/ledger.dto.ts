import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class LedgerRestartRequestDto extends createZodDto(
    z
        .object({
            reason: z.string().max(500).optional(),
        })
        .optional()
        .default({}),
) {}
