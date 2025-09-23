import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { InspectorEntity } from './inspector.entity';
import { Inspector } from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';

@Injectable()
export class InspectorService {

    constructor(
        private http: HttpService,
        @InjectRepository(InspectorEntity) private readonly inspectorRepository: Repository<InspectorEntity>,

        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,

        @Inject(forwardRef(() => OrderService))
        private readonly orderService: OrderService,
    ) {
    }

    async getAll(): Promise<InspectorEntity[]> {
        return this.inspectorRepository.find();
    }

    async create(name: string, options: Inspector): Promise<InspectorEntity> {
        let inspector = await this.inspectorRepository.findOne({ where: { name } });
        if (inspector) {
            inspector.options = options
            await this.inspectorRepository.update(inspector.id, inspector);
        }
        else {
            await this.inspectorRepository.save({ name, options } as any);
            inspector = await this.inspectorRepository.findOne({ where: { name } });
        }

        return inspector;
    }

    async get(sysname: string): Promise<Inspector> {
        let result: Inspector = {
            key: '',
            restApiUrl: null,
            connectors: [],
            apiPort: 0,
            riskManagement: undefined,
            assetManagement: undefined,
            tradeSettings: undefined,
            strategyLogic: undefined,
            general: undefined
        }

        const inspector = await this.inspectorRepository.findOne({ where: { name: sysname } });
        if (inspector) result = inspector.options

        return result
    }


    async update(name: string, options: Inspector): Promise<any> {

        let inspector = await this.inspectorRepository.findOne({ where: { name } });
        inspector.options = options
        if (inspector) await this.inspectorRepository.update(inspector.id, inspector);
        return inspector;
    }

    async delete(name: string): Promise<any> {
        const inspector = await this.inspectorRepository.findOne({ where: { name } });
        if (inspector) {
            this.inspectorRepository.delete(inspector.id);
            return true;
        } else {
            return false;
        }
    }


}
