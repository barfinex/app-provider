import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { ConnectorType, MarketType } from '@barfinex/types';
import { SignalsService } from './signals.service';

@ApiTags('Signals')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('signals')
export class SignalsController {
  private readonly logger = new Logger(SignalsController.name);

  constructor(private readonly signalsService: SignalsService) {}

  @Get('context/:symbol')
  @ApiOperation({
    summary: 'Signal context for symbol',
    description:
      'Builds and returns signal context for a symbol: candles, orderbook, order flow. Used for strategy/signal engines.',
  })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiQuery({ name: 'connectorType', required: false, enum: ['BINANCE'] })
  @ApiQuery({ name: 'marketType', required: false, enum: ['SPOT', 'FUTURES'] })
  @ApiQuery({ name: 'daysD1', required: false })
  @ApiQuery({ name: 'daysH4', required: false })
  @ApiQuery({ name: 'daysH1', required: false })
  @ApiQuery({ name: 'candlesKey', required: false })
  @ApiQuery({ name: 'candlesMode', required: false })
  @ApiOkResponse({
    description: 'Signal context (candles, orderBook, orderFlow, etc.)',
  })
  async getContext(
    @Param('symbol') symbol: string,
    @Query('connectorType') connectorType?: ConnectorType,
    @Query('marketType') marketType?: MarketType,
    @Query('daysD1') daysD1?: string,
    @Query('daysH4') daysH4?: string,
    @Query('daysH1') daysH1?: string,
    @Query('candlesKey') candlesKey?: string,
    @Query('candlesMode') candlesMode?: string,
  ) {
    const ctx = await this.signalsService.buildSignalContext({
      symbol: symbol.toUpperCase(),
      connectorType: connectorType ?? ConnectorType.binance,
      marketType: marketType ?? MarketType.futures,
      days: {
        d1: daysD1 ? Number(daysD1) : undefined,
        h4: daysH4 ? Number(daysH4) : undefined,
        h1: daysH1 ? Number(daysH1) : undefined,
      },
      candlesKey,
      candlesMode,
    });
    const orderbookLevels = ((ctx as any)?.orderBook?.levels?.length ??
      0) as number;
    const tradesWindow = ((ctx as any)?.orderFlow?.windowTrades ?? 0) as number;
    this.logger.debug(
      `[SIGNALS] context ${symbol.toUpperCase()}: candles.h1=${
        ctx.candles?.h1?.length ?? 0
      }, orderbook=${orderbookLevels}, tradesWindow=${tradesWindow}`,
    );
    return ctx;
  }
}
