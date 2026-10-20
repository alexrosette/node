import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { InternalModule } from '../internal/internal.module';
import { XrayModule } from '../xray-core/xray.module';
import { LedgerController } from './ledger.controller';
import { LedgerGuard } from './ledger.guard';
import { LedgerService } from './ledger.service';

@Module({
    imports: [CqrsModule, InternalModule, XrayModule],
    providers: [LedgerService, LedgerGuard],
    controllers: [LedgerController],
})
export class LedgerModule {}
