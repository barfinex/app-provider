import { Controller, Get, Param } from '@nestjs/common';
import { Symbol, MarketType, ConnectorType } from '@barfinex/types';
import { SymbolService, } from './symbol.service';
import { ApiTags } from '@nestjs/swagger';


@ApiTags('Symbols')
@Controller('symbols')
export class SymbolController {

    constructor(private symbolSecvice: SymbolService) { }

    @Get(':connectorType/:marketType')
    async getSymbolInfo(@Param('connectorType') connectorType: ConnectorType, @Param('marketType') marketType: MarketType): Promise<Symbol[]> {
        return await this.symbolSecvice.getAllSymbols(connectorType, marketType);
    }

}
