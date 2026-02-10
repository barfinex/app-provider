import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb-query.service';

export interface DetectorEntity {
    key: string;
    name: string;
    options: any;
    created: number;
    updated: number;
}

@Injectable()
export class DetectorRepository {
    constructor(private readonly reader: QuestDBQueryService) { }

    async getByKey(key: string) {
        key = key.replace(/'/g, "''");

        return this.reader.query(`
            SELECT *
            FROM detectors
            WHERE key='${key}'
        `);
    }

}
