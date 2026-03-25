import { Module, Logger } from '@nestjs/common';
import {
  TradingDiagnosticsService,
  TradingDiagnosticsWriter,
} from '@barfinex/diagnostics';

function createDiagnosticsWriter(logger: Logger): TradingDiagnosticsWriter {
  return {
    log(message: string): void {
      logger.log(message);
    },
  };
}

@Module({
  providers: [
    {
      provide: TradingDiagnosticsService,
      useFactory: () => {
        const logger = new Logger('TradingDiagnostics');
        return new TradingDiagnosticsService({
          writer: createDiagnosticsWriter(logger),
          enabled:
            String(process.env.TRADING_DIAGNOSTICS_ENABLED ?? 'true') ===
            'true',
        });
      },
    },
  ],
  exports: [TradingDiagnosticsService],
})
export class DiagnosticsModule {}
