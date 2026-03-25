import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Account, MarketType, ConnectorType, TradingSymbol } from '@barfinex/types';
import { AccountService } from './account.service';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

@ApiTags('Accounts')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('accounts')
export class AccountController {
  constructor(private accountSecvice: AccountService) {}

  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get account info',
    description:
      'Returns account info for the given connector and market type.',
  })
  @ApiParam({ name: 'connectorType', example: 'BINANCE' })
  @ApiParam({ name: 'marketType', example: 'FUTURES' })
  @ApiOkResponse({ description: 'Account (balances, positions, etc.)' })
  getAccountInfo(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ): Promise<Account> {
    return this.accountSecvice.getAccountInfo(connectorType, marketType);
  }

  @Put('leverage')
  @ApiOperation({
    summary: 'Change leverage',
    description:
      'Changes leverage for a symbol on the given connector. Body: symbol, leverage, connectorType.',
  })
  @ApiBody({ description: 'symbol, leverage, connectorType' })
  @ApiOkResponse({ description: 'Leverage update result' })
  async changeLeverage(
    @Body('symbol') symbol: TradingSymbol,
    @Body('leverage') leverage: number,
    @Body('connectorType') connectorType: ConnectorType,
  ) {
    return await this.accountSecvice.changeLeverage(
      connectorType,
      symbol,
      leverage,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List all accounts',
    description: 'Returns all accounts (all connector/market combinations).',
  })
  @ApiOkResponse({ description: 'List of accounts' })
  async all() {
    return this.accountSecvice.getAll();
  }
}
