import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConnectorType, MarketType } from '@barfinex/types';
import { SignalsService } from './signals.service';

@ApiTags('Signals')
@Controller('signals')
export class SignalsController {
    constructor(private readonly signalsService: SignalsService) { }

    @Get('context/:symbol')
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
        return this.signalsService.buildSignalContext({
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
    }
}

