import { ConflictException, ForbiddenException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { catchError, map, lastValueFrom } from 'rxjs';
import { DetectorEntity } from './detector.entity';
import { Detector, MarketType, ConnectorType, TimeFrame, Trade, Symbol, Provider } from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';
import { Candle } from 'tinkoff-invest-api/cjs/generated/marketdata';
import { plainToInstance } from 'class-transformer';
import { Indicator } from '@barfinex/types';


@Injectable()
export class DetectorService {

    constructor(
        private http: HttpService,
        @InjectRepository(DetectorEntity)
        private readonly detectorRepository: Repository<DetectorEntity>,

        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,

        @Inject(forwardRef(() => OrderService))
        private readonly orderService: OrderService,
    ) {
    }

    async getAllDetectorsByProviderKey(providerKey: string): Promise<Detector[]> {


        console.log('getAllDetectorsByProviderKey', providerKey);

        const entities = await this.detectorRepository.find({
            where: {
                'options.providers': {
                    $elemMatch: {
                        key: providerKey,
                    },
                },
            } as any,
        });

        return entities.map((e) => e.options);
    }

    async getAllDetectors(): Promise<Detector[]> {
        const entities = await this.detectorRepository.find();
        return entities.map(e => e.options);
    }

    async createDetector(detector: Detector): Promise<Detector> {
        const existing = await this.detectorRepository.findOneBy({ key: detector.key });

        if (existing) {
            throw new ConflictException(`Detector with key "${detector.key}" already exists`);
        }

        const entity = this.detectorRepository.create({
            key: detector.key,
            name: detector.sysname,
            options: detector,
        });

        const saved = await this.detectorRepository.save(entity);
        return saved.options;
    }


    async updateDetectorByKey(key: string, update: Partial<Detector>): Promise<Detector | null> {
        const entity = await this.detectorRepository.findOneBy({ key });

        if (!entity) return null;

        const updatedOptions = { ...entity.options, ...update };

        await this.detectorRepository.update({ key }, {
            options: updatedOptions,
            name: updatedOptions.sysname || entity.name,
        });

        return updatedOptions;
    }


    async deleteDetectorByKey(key: string): Promise<boolean> {
        const result = await this.detectorRepository.delete({ key });
        return result.affected === 1;
    }


    async deleteAllOrders(options: { connectorType: ConnectorType, marketType: MarketType, symbols?: Symbol[], sysname: string }): Promise<boolean> {
        const { connectorType, marketType, symbols, sysname: sysname } = options
        return await this.orderService.deleteAll({ connectorType, marketType, symbols });
    }

    async updateSubscribeCollectionInConnector(options: { connectorType: ConnectorType, marketType: MarketType, symbols: Symbol[], intervals?: TimeFrame[] }): Promise<any> {
        const { connectorType, marketType, symbols, intervals } = options
        return await this.connectorService.updateSubscribeCollection(connectorType, marketType, symbols, intervals);
    }

    async create(detector: Detector): Promise<Detector> {
        const { key } = detector;

        let existing = await this.detectorRepository.findOne({ where: { key } });

        if (existing) {
            existing.options = detector;

            // ✅ save вместо update — обновит updatedAt
            await this.detectorRepository.save(existing);
            return existing.options;
        }

        const newDetector = this.detectorRepository.create({
            key,
            options: detector,
        });

        const saved = await this.detectorRepository.save(newDetector);
        return saved.options;
    }



    async getAllActiveSymbols(): Promise<Symbol[]> {
        const detectors = await this.detectorRepository.find()
        const result: Symbol[] = []
        detectors.forEach((detector) => {
            const { isActive, symbols } = detector.options;
            if (isActive) {
                symbols.forEach(symbol => {
                    if (!result.find(q => q.name == symbol.name))
                        result.push({ name: symbol.name });
                })
            }
        })
        return result;
    }

    async getDetector(options: { sysname?: string, key?: string }): Promise<Detector> {

        const { sysname, key } = options

        let result: Detector = {
            key: '',
            sysname: '',
            logLevel: '',
            currency: '',
            useNotifications: {
                telegram: {
                    token: '',
                    chatId: '',
                    messageFormat: '',
                    isActive: false
                }
            },
            advisor: {
                key: '',
                restApiUrl: '',
                providerApi: '',
                connectorTypes: [],
                marketTypes: [],
                takeProfitPercent: 0,
                stopLossPercent: 0,
                commisions: [],
                aiIntegration: {
                    apiKey: '',
                    defaultModel: '',
                    responseTemperature: 0,
                    maxTokens: 0,
                    supportedFeatures: []
                },
                cacheSettings: {
                    cacheHost: '',
                    cachePort: 0,
                    defaultTTL: 0
                },
                scenarioAnalysis: {
                    enabled: false,
                    predefinedScenarios: [],
                    maxAnalysisDepth: 0,
                    customScenarios: []
                },
                logging: {
                    verbose: false,
                    logFilePath: '',
                    externalMonitoring: false
                },
                portfolioOptimization: {
                    enabled: false,
                    riskTolerance: 'low',
                    strategies: []
                }
            },
            restApiUrl: '',
            providers: [],
            symbols: [],
            orders: [],
            intervals: [],
            indicators: [],
            useSandbox: false,
            useScratch: false,
            subscriptions: []
        }

        const whereCondition = sysname ? { name: sysname } : key ? { key: key } : null;

        if (!whereCondition) return result;

        const detector = await this.detectorRepository.findOne({ where: whereCondition });
        if (detector) result = detector.options

        return result
    }




    async getPrices(options: { sysname?: string, key?: string; symbols: Symbol[] }): Promise<{ [index: string]: { value: number, moment: number } }> {

        const { sysname, key, symbols } = options

        let result: { [index: string]: { value: number, moment: number } } = {}

        const detector = await this.getDetector({ sysname })

        for (const provider of detector.providers) {
            if (detector && provider.restApiUrl) {
                try {
                    const url = `${provider.restApiUrl}/symbols/lasttrades`;
                    const request = this.http
                        .get(url)
                        .pipe(map((res) => res.data))
                        .pipe(
                            catchError((err) => {
                                throw new ForbiddenException(`${url} ${err}`);
                            }),
                        );

                    const trades: { [index: string]: Trade } = await lastValueFrom(request)

                    Object.keys(trades).forEach(key => {
                        result[key] = {
                            value: trades[key].price,
                            moment: trades[key].time,
                        }
                    });
                } catch { }

                return result;
            }
        }

        return result
    }


    async getSymbolIndocatorState(options: { sysname?: string, key?: string; symbol: Symbol, selectIndicators: string[], interval: TimeFrame }): Promise<any> {

        let result: any[] = []

        const { sysname, key, symbol, selectIndicators, interval } = options

        const detector = await this.getDetector({ sysname, key })

        for (const provider of detector.providers) {
            if (options && provider.restApiUrl) {

                try {

                    const url = `${provider.restApiUrl}/symbols/${symbol}/indicators/${interval}?selectIndicators=${selectIndicators}`;
                    const request = this.http
                        .get(url)
                        .pipe(map((res) => res.data))
                        .pipe(
                            catchError((err) => {
                                throw new ForbiddenException(`${url} ${err}`);
                            }),
                        );

                    result = await lastValueFrom(request)

                } catch { }
            }
        }

        return result
    }


    async getSymbolCandlesState(options: { sysname?: string, key?: string; symbol: Symbol, interval: TimeFrame, orderBy: string }): Promise<any> {

        const { sysname, key, symbol, interval, orderBy } = options


        let result: Candle[] = []
        const detector = await this.getDetector({ sysname, key })

        for (const provider of detector.providers) {
            if (options && provider.restApiUrl) {
                try {
                    let url = `${provider.restApiUrl}/symbols/${symbol}/candles/${interval}`;
                    if (orderBy) url += '?orderBy=' + orderBy
                    const request = this.http
                        .get(url)
                        .pipe(map((res) => res.data))
                        .pipe(
                            catchError((err) => {
                                throw new ForbiddenException(`${url} ${err}`);
                            }),
                        );
                    result = await lastValueFrom(request)
                } catch { }
            }


        }


        return result
    }


    async getSymbols(sysname: string): Promise<any> {
        let result = [];
        const detector = await this.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        const connectorLastTrade = await this.connectorService.getPrices(
                            connector.connectorType,
                            market.marketType,
                            market.symbols
                        );
                        const detectorLastPrice = await this.getPrices({ sysname, symbols: detector.symbols });

                        for (const symbol of detector.symbols) {
                            const value: any = {
                                name: symbol.name,
                                leverage: symbol.leverage,
                                defaultQuantity: symbol.quantity,
                                intervals: detector.intervals,
                                orders: [],
                                connectorLastTrade: connectorLastTrade[symbol.name]
                                    ? {
                                        value: connectorLastTrade[symbol.name].value,
                                        moment: connectorLastTrade[symbol.name].moment,
                                    }
                                    : { value: 0, moment: null },
                                detectorLastPrice: detectorLastPrice[symbol.name]
                                    ? {
                                        value: detectorLastPrice[symbol.name].value,
                                        moment: detectorLastPrice[symbol.name].moment,
                                    }
                                    : { value: 0, moment: null },
                            };

                            result.push(value);
                        }
                    }
                }
        }

        return result;
    }







    async getSymbolState(sysname: string, symbol: Symbol): Promise<any> {
        return {}
    }


    async getPluginState(sysname: string, pluginSysname: string): Promise<any> {
        return {}
    }


    async update(name: string, options: Detector): Promise<any> {

        let detector = await this.detectorRepository.findOne({ where: { name } });
        if (detector) {
            detector.options = options
            await this.detectorRepository.update(detector.id, detector);
        }
        return detector;
    }

    async delete(name: string): Promise<any> {
        const detector = await this.detectorRepository.findOne({ where: { name } });
        if (detector) {
            this.detectorRepository.delete(detector.id);
            return true;
        } else {
            return false;
        }
    }


}
