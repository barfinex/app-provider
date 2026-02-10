import {
    Body,
    Controller,
    Delete,
    Get,
    InternalServerErrorException,
    Param,
    Post,
    Put,
    Query,
} from '@nestjs/common';

import { DetectorService } from './detector.service';
import { ConnectorService } from '../connector/connector.service';

import { Detector, Symbol, TimeFrame } from '@barfinex/types';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Detectors')
@Controller('detectors')
export class DetectorController {
    constructor(
        private readonly connectorService: ConnectorService,
        private readonly detectorService: DetectorService,
    ) { }

    // -------------------------------------------------------
    // GET ALL DETECTORS FOR CURRENT PROVIDER
    // -------------------------------------------------------
    @Get()
    async getAll() {
        const key = this.connectorService.key;

        if (!key) {
            throw new InternalServerErrorException(
                'Provider key not initialized yet',
            );
        }

        return this.detectorService.getAllDetectorsByProviderKey(key);
    }

    // -------------------------------------------------------
    // GET ONE DETECTOR
    // -------------------------------------------------------
    @Get(':key')
    async get(@Param('key') key: string) {
        return this.detectorService.getDetector({ key });
    }

    // -------------------------------------------------------
    // CREATE NEW DETECTOR
    // -------------------------------------------------------
    @Post()
    async registration(@Body('detector') detector: Detector) {
        console.log('Registration detector:', detector);

        return await this.detectorService.createDetector(detector);
    }

    // -------------------------------------------------------
    // UPDATE DETECTOR CONFIG
    // -------------------------------------------------------
    @Put(':key')
    async update(
        @Param('key') key: string,
        @Body('options') options: Detector,
    ) {
        const updated = await this.detectorService.updateDetectorByKey(key, options);
        if (!updated) return null;

        // Пересобираем подписки (как в старой логике)
        const activeSymbols = await this.detectorService.getAllActiveSymbols();

        for (const provider of options.providers) {
            if (!provider.connectors) continue;

            for (const connector of provider.connectors) {
                for (const market of connector.markets) {
                    await this.detectorService.updateSubscribeCollectionInConnector({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        symbols: activeSymbols,
                        intervals: options.intervals,
                    });
                }
            }
        }

        return updated;
    }

    // -------------------------------------------------------
    // DELETE DETECTOR BY KEY
    // -------------------------------------------------------
    @Delete(':key')
    async delete(@Param('key') key: string) {
        const detector = await this.detectorService.getDetector({ key });
        if (!detector) return false;

        let isDelete = false;

        for (const provider of detector.providers) {
            if (!provider.connectors) continue;

            for (const connector of provider.connectors) {
                for (const market of connector.markets) {
                    // 1. Удаляем ордера для этого детектора
                    await this.detectorService.deleteAllOrders({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        sysname: detector.sysname,
                    });

                    // 2. Удаляем детектор
                    isDelete = await this.detectorService.deleteDetectorByKey(key);

                    // 3. Перестраиваем подписки
                    const activeSymbols =
                        await this.detectorService.getAllActiveSymbols();

                    await this.detectorService.updateSubscribeCollectionInConnector({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        symbols: activeSymbols,
                        intervals: detector.intervals,
                    });
                }
            }
        }

        return isDelete;
    }

    // -------------------------------------------------------
    // PLUGINS
    // -------------------------------------------------------
    @Get(':key/plugins/:pluginkey')
    async getDetectorPluginState(
        @Param('key') key: string,
        @Param('pluginkey') pluginkey: string,
    ) {
        return this.detectorService.getPluginState(key, pluginkey);
    }

    // -------------------------------------------------------
    // SYMBOLS
    // -------------------------------------------------------
    @Get(':key/symbols')
    async getDetectorSymbols(@Param('key') key: string) {
        return this.detectorService.getSymbols(key);
    }

    @Get(':key/symbols/:symbol')
    async getDetectorSymbolState(
        @Param('key') key: string,
        @Param('symbol') symbol: Symbol,
    ) {
        return this.detectorService.getSymbolState(key, symbol);
    }

    // -------------------------------------------------------
    // CANDLES
    // -------------------------------------------------------
    @Get(':key/symbols/:symbol/candles')
    async getDetectorSymbolCandles(
        @Param('key') key: string,
        @Param('symbol') symbol: Symbol,
    ) {
        const detector = await this.detectorService.getDetector({ key });
        return detector.intervals;
    }

    @Get(':key/symbols/:symbol/candles/:interval')
    async getDetectorSymbolCandlesState(
        @Param('key') key: string,
        @Param('symbol') symbol: Symbol,
        @Param('interval') interval: TimeFrame,
        @Query() reqParams: any,
    ) {
        const { orderBy } = reqParams;
        return this.detectorService.getSymbolCandlesState({
            key,
            symbol,
            interval,
            orderBy,
        });
    }

    // -------------------------------------------------------
    // INDICATORS
    // -------------------------------------------------------
    @Get(':key/symbols/:symbol/indicators')
    async getDetectorSymbolIndicators(
        @Param('key') key: string,
        @Param('symbol') symbol: Symbol,
    ) {
        const detector = await this.detectorService.getDetector({ key });
        return detector.indicators;
    }

    @Get(':key/symbols/:symbol/indicators/:interval')
    async getDetectorSymbolIndicatorState(
        @Param('key') key: string,
        @Param('symbol') symbol: Symbol,
        @Param('interval') interval: TimeFrame,
        @Query() reqParams: any,
    ) {
        const { selectIndicators } = reqParams;

        return this.detectorService.getSymbolIndocatorState({
            key,
            symbol,
            selectIndicators,
            interval,
        });
    }
}
