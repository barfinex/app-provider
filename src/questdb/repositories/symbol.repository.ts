import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb-query.service';

export interface SymbolEntity {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  connectorType: string;
  marketType: string;
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class SymbolRepository {
  constructor(private readonly reader: QuestDBQueryService) { }

  async getAll() {
    return this.reader.query(`
      SELECT *
      FROM symbols
      ORDER BY symbol
    `);
  }
}
