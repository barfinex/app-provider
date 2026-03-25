import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb-query.service';

export interface InspectorEntity {
  name: string;
  options: any;
  created: number;
  updated: number;
}

@Injectable()
export class InspectorRepository {
  constructor(private readonly reader: QuestDBQueryService) {}

  async getAll() {
    return this.reader.query(`SELECT * FROM inspectors LIMIT 1000`);
  }
}
