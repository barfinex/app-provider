import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Account, MarketType, ConnectorType, Symbol } from '@barfinex/types';
import { AccountService, } from './account.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Accounts')
@Controller('accounts')
export class AccountController {

    constructor(private accountSecvice: AccountService) { }

    @Get(':connectorType/:marketType')
    getAccountInfo(@Param('connectorType') connectorType: ConnectorType, @Param('marketType') marketType: MarketType): Promise<Account> {
        // console.log('test');
        return this.accountSecvice.getAccountInfo(connectorType, marketType);
    }


    // @Get(':detectorSysname')
    // getAccountInfoByDetectorSysname(@Param('detectorSysname') detectorSysname: string): Promise<Account> {
    //     return this.accountSecvice.getAccountInfoByDetectorSysname(detectorSysname);
    // }

    @Put('leverage')
    async changeLeverage(
        @Body('symbol') symbol: Symbol,
        @Body('leverage') leverage: number,
        @Body('connectorType') connectorType: ConnectorType
    ) {
        return await this.accountSecvice.changeLeverage(connectorType, symbol, leverage)
    }

    @Get()
    async all() {
        return this.accountSecvice.getAll();
    }


}
