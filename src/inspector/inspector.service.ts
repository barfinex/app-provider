// src/inspector/inspector.service.ts
import {
    Injectable,
    Inject,
    InternalServerErrorException,
    NotFoundException,
    forwardRef,
} from '@nestjs/common';

import { HttpService } from '@nestjs/axios';

import { InspectorRepository, InspectorEntity } from './inspector.repository';
import { Inspector } from '@barfinex/types';

import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';

@Injectable()
export class InspectorService {
    constructor(
        private readonly http: HttpService,

        private readonly inspectorRepository: InspectorRepository,

        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,

        @Inject(forwardRef(() => OrderService))
        private readonly orderService: OrderService,
    ) { }

    // -------------------------------------------------------
    // GET ALL
    // -------------------------------------------------------
    async getAll(): Promise<InspectorEntity[]> {
        return this.inspectorRepository.find();
    }

    // -------------------------------------------------------
    // CREATE OR UPDATE
    // -------------------------------------------------------
    async create(name: string, options: Inspector): Promise<InspectorEntity> {
        const existing = await this.inspectorRepository.findOne({ where: { name } });

        if (existing) {
            existing.options = options;
            await this.inspectorRepository.update(name, {
                options,
                updatedAt: Date.now(),
            });
            return existing;
        }

        const entity = this.inspectorRepository.create({ name, options });
        await this.inspectorRepository.insert(entity);
        return entity;
    }

    // -------------------------------------------------------
    // GET (with default)
    // -------------------------------------------------------
    async get(sysname: string): Promise<Inspector> {
        const empty: Inspector = {
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

        const found = await this.inspectorRepository.findOne({
            where: { name: sysname },
        });

        return found ? found.options : empty;
    }

    // -------------------------------------------------------
    // UPDATE
    // -------------------------------------------------------
    async update(name: string, options: Inspector): Promise<InspectorEntity> {
        const existing = await this.inspectorRepository.findOne({ where: { name } });

        if (!existing) throw new NotFoundException(`Inspector "${name}" not found`);

        existing.options = options;

        await this.inspectorRepository.update(name, {
            options,
            updatedAt: Date.now(),
        });

        return existing;
    }

    // -------------------------------------------------------
    // DELETE
    // -------------------------------------------------------
    async delete(name: string): Promise<boolean> {
        const existing = await this.inspectorRepository.findOne({ where: { name } });

        if (!existing) return false;

        await this.inspectorRepository.delete(name);
        return true;
    }
}
