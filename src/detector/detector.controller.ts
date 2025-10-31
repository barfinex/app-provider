import { Body, Controller, Delete, Get, InternalServerErrorException, Post, Put } from '@nestjs/common';
import { Param, Query } from '@nestjs/common/decorators/http/route-params.decorator';
import { DetectorService } from './detector.service';
import { ConnectorService } from '../connector/connector.service';
import { Detector, Symbol, TimeFrame } from '@barfinex/types';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Detectors')
@Controller('detectors')
export class DetectorController {

    constructor(
        private connectorService: ConnectorService,
        private detectorService: DetectorService,
    ) {

    }

    @Get()
    async getAll() {
        const key = this.connectorService.key;

        if (!key) {
            throw new InternalServerErrorException('Provider key not initialized yet');
        }

        return this.detectorService.getAllDetectorsByProviderKey(key);
    }

    @Get(':key')
    async get(@Param('key') key: string) {
        return this.detectorService.getDetector({ key })
    }

    @Post()
    async registration(
        // @Body('key') key: string,
        @Body('detector') detector: Detector
    ) {
        // const { intervals, useScratch } = options;


        console.log('registration !!!!!!!!!! detector', detector);

        const existing = await this.detectorService.create(detector);

        // for (const provider of options.providers) {
        //     for (const connector of provider.connectors) {
        //         for (const market of connector.markets) {

        //             if (useScratch) {
        //                 await this.detectorService.deleteAllOrders({
        //                     connectorType: connector.connectorType,
        //                     marketType: market.marketType,
        //                     symbols: market.symbols,
        //                     sysname: existing.options.sysname,
        //                 })
        //             }

        //             const activeSymbols = await this.detectorService.getAllActiveSymbols();
        //             await this.detectorService.updateSubscribeCollectionInConnector({
        //                 connectorType: connector.connectorType,
        //                 marketType: market.marketType,
        //                 symbols: activeSymbols,
        //                 intervals,
        //             })
        //         }
        //     }
        // }

        return existing;
    }


    @Put(':key')
    async update(
        @Param('key') key: string,
        @Body('options') options: Detector
    ) {
        const detectorEntity = await this.detectorService.update(key, options);
        const activeSymbols = await this.detectorService.getAllActiveSymbols();

        for (const provider of options.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        await this.detectorService.updateSubscribeCollectionInConnector({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                            symbols: activeSymbols,
                            intervals: options.intervals
                        });

                    }
                }
        }

        return detectorEntity;
    }


    @Delete(':key')
    async delete(@Param('key') key: string) {
        let isDelete = false;
        const detector = await this.detectorService.getDetector({ key });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        await this.detectorService.deleteAllOrders({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                            symbols: market.symbols,
                            sysname: detector.sysname,
                        });

                        // Delete the detector
                        isDelete = await this.detectorService.delete(key);

                        // Update subscription collection in the connector
                        const activeSymbols = await this.detectorService.getAllActiveSymbols();
                        await this.detectorService.updateSubscribeCollectionInConnector({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                            symbols: activeSymbols,
                            intervals: detector.intervals
                        });
                    }
                }
        }

        return isDelete;
    }




    @Get(':key/plugins/:pluginkey')
    async getDetectorPluginState(@Param('key') key: string, @Param('pluginkey') pluginkey: string) {
        return this.detectorService.getPluginState(key, pluginkey)
    }


    @Get(':key/symbols')
    async getDetectorSymbols(@Param('key') key: string) {
        return this.detectorService.getSymbols(key)
    }

    @Get(':key/symbols/:symbol')
    async getDetectorSymbolState(@Param('key') key: string, @Param('symbol') symbol: Symbol) {
        return this.detectorService.getSymbolState(key, symbol)
    }


    @Get(':key/symbols/:symbol/candles')
    async getDetectorSymbolCandles(@Param('key') key: string, @Param('symbol') symbol: Symbol) {
        const detector = await this.detectorService.getDetector({ key })
        return detector.intervals
    }

    @Get(':key/symbols/:symbol/candles/:interval')
    async getDetectorSymbolCandlesState(@Param('key') key: string, @Param('symbol') symbol: Symbol, @Param('interval') interval: TimeFrame, @Query() reqParams: any) {

        const { orderBy } = reqParams

        return this.detectorService.getSymbolCandlesState({ key, symbol, interval, orderBy })
    }

    @Get(':key/symbols/:symbol/indicators')
    async getDetectorSymbolIndocators(@Param('key') key: string, @Param('symbol') symbol: Symbol) {
        const detector = await this.detectorService.getDetector({ key })
        return detector.indicators
    }

    @Get(':key/symbols/:symbol/indicators/:interval')
    async getDetectorSymbolIndocatorState(@Param('key') key: string, @Param('symbol') symbol: Symbol, @Param('indicator') indicator: string, @Param('interval') interval: TimeFrame, @Query() reqParams: any) {
        const { selectIndicators } = reqParams
        return this.detectorService.getSymbolIndocatorState({ key, symbol, selectIndicators, interval })
    }

}
