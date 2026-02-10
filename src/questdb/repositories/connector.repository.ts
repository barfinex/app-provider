import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb-query.service';

export interface ConnectorEntity {
    connectorType: string;
    options: string;
    created: number;
    updated: number;
}

@Injectable()
export class ConnectorRepository {
    constructor(private readonly reader: QuestDBQueryService) { }

    async getAll() {
        return this.reader.query(`SELECT * FROM connectors ORDER BY updated DESC`);
    }
}
