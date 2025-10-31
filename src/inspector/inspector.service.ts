import {
    Inject,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
    forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { InspectorEntity } from './inspector.entity';
import {
    Inspector,
} from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';

@Injectable()
export class InspectorService {
    constructor(
        private readonly http: HttpService,

        @InjectRepository(InspectorEntity)
        private readonly inspectorRepository: Repository<InspectorEntity>,

        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,

        @Inject(forwardRef(() => OrderService))
        private readonly orderService: OrderService,
    ) { }

    /** Получить все инспекторы */
    async getAll(): Promise<InspectorEntity[]> {
        return await this.inspectorRepository.find();
    }

    /** Создать или обновить инспектора */
    async create(name: string, options: Inspector): Promise<InspectorEntity> {
        let inspector = await this.inspectorRepository.findOne({ where: { name } });

        if (inspector) {
            inspector.options = options;
            // ✅ безопасное обновление с отключенной строгой проверкой типов
            await this.inspectorRepository.update(inspector.id, inspector as any);
        } else {
            await this.inspectorRepository.save({ name, options } as any);
            inspector = await this.inspectorRepository.findOne({ where: { name } });
        }

        if (!inspector) {
            throw new InternalServerErrorException(
                `Failed to create or update inspector "${name}"`,
            );
        }

        return inspector;
    }

    /** Получить конфигурацию инспектора по имени (sysname) */
    async get(sysname: string): Promise<Inspector> {
        let result: Inspector = {
            key: '',
            restApiUrl: '',
            general: { apiPort: 0 },
            connectors: [],
            apiPort: 0,
            riskManagement: {},
            assetManagement: {
                excludedAssets: [],
                preferredAssets: [],
                slippageTolerancePercent: 0,
                spreadTolerancePercent: 0,
            },
            tradeSettings: {
                maxPositionHoldTime: 0,
                maxPositionSizePercent: 0,
                minPositionSizePercent: 0,
                maxLeverage: 0,
                defaultLeverage: 0,
                trailingStopPercent: 0,
                trailingTakeProfitPercent: 0,
            },
            strategyLogic: {
                cooldownPeriod: 0,
                maxConsecutiveLosses: 0,
                minROIThreshold: 0,
                maxROIThreshold: 0,
            },
        };

        const inspector = await this.inspectorRepository.findOne({
            where: { name: sysname },
        });

        if (inspector) result = inspector.options;
        return result;
    }

    /** Обновить существующего инспектора */
    async update(name: string, options: Inspector): Promise<InspectorEntity> {
        const inspector = await this.inspectorRepository.findOne({ where: { name } });

        if (!inspector) {
            throw new NotFoundException(`Inspector with name "${name}" not found`);
        }

        inspector.options = options;
        await this.inspectorRepository.update(inspector.id, inspector as any);

        return inspector;
    }

    /** Удалить инспектора по имени */
    async delete(name: string): Promise<boolean> {
        const inspector = await this.inspectorRepository.findOne({ where: { name } });

        if (!inspector) return false;

        await this.inspectorRepository.delete(inspector.id);
        return true;
    }
}
