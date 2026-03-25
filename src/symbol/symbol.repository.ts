import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { SymbolEventAdapter } from '../questdb/event-sink/adapters/symbol.adapter';

// ⚠️ ПОДСТАВЬ свои реальные типы/импорты ILP-сервиса:
// например, если у тебя уже есть ILPWriteOptions и QuestDbIlpWriter
// в модуле с свечами — импортируй их отсюда.
import { ILPWriteOptions } from '../questdb/ilp/types';
import { QuestDbIlpWriterService } from '../questdb/ilp/questdb-ilp-writer.service';

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
  constructor(
    public readonly reader: QuestDBQueryService,
    private readonly events: SymbolEventAdapter,
    private readonly ilpWriter: QuestDbIlpWriterService, // 🔹 новый ILP-writer
  ) {}

  /** Экранирование строк для SQL (осталось только для SELECT/TRUNCATE) */
  private esc(v: string): string {
    return v.replace(/'/g, "''");
  }

  /** Получить все символы */
  async getAll(): Promise<SymbolEntity[]> {
    return this.reader.queryAsObjects(`
      SELECT *
      FROM symbols
      ORDER BY symbol
    `);
  }

  /** Получить символы по connector+market */
  async getByConnector(
    connectorType: string,
    marketType: string,
  ): Promise<SymbolEntity[]> {
    return this.reader.queryAsObjects(`
      SELECT *
      FROM symbols
      WHERE connectorType='${this.esc(connectorType)}'
        AND marketType='${this.esc(marketType)}'
      ORDER BY symbol
    `);
  }

  private static deleteLock: Promise<void> = Promise.resolve();

  async deleteAll(connectorType: string, marketType: string): Promise<void> {
    const ct = this.esc(connectorType);
    const mt = this.esc(marketType);

    SymbolRepository.deleteLock = SymbolRepository.deleteLock.then(async () => {
      // 1. Удаляем остатки symbols_clean, если они остались от предыдущего падения
      await this.reader.query(`DROP TABLE IF EXISTS symbols_clean;`);

      // 2. Если основной таблицы нет — выходим
      await this.reader
        .query(
          `
      SELECT * FROM symbols LIMIT 1;
    `,
        )
        .catch(() => null); // swallow

      // 3. Пересоздаём таблицу БЕЗ binance/futures
      await this.reader
        .query(
          `
      CREATE TABLE symbols_clean AS (
        SELECT *
        FROM symbols
        WHERE connectorType != '${ct}'
           OR marketType != '${mt}'
      );
    `,
        )
        .catch(() => null);

      // 4. Дропаем основную symbols
      await this.reader.query(`DROP TABLE IF EXISTS symbols;`);

      // 5. Переносим новую таблицу на её место
      await this.reader
        .query(`RENAME TABLE symbols_clean TO symbols;`)
        .catch(() => null);
    });

    return SymbolRepository.deleteLock;
  }

  // /**
  //  * Вставка одного символа через ILP.
  //  * Останется на случай единичных операций, но в массовых сценариях
  //  * всё пойдёт через insertMany (bulk).
  //  */
  // async insert(symbol: SymbolEntity): Promise<void> {
  //   const tsNs = symbol.createdAt * 1_000_000; // наносекунды

  //   const line: ILPWriteOptions = {
  //     table: 'symbols',
  //     keys: {
  //       symbol: symbol.symbol,
  //       connectorType: symbol.connectorType,
  //       marketType: symbol.marketType,
  //     },
  //     fields: {
  //       baseAsset: symbol.baseAsset,
  //       quoteAsset: symbol.quoteAsset,
  //       status: symbol.status,
  //       createdAt: symbol.createdAt,
  //       updatedAt: symbol.updatedAt,
  //     },
  //     timestamp: tsNs,
  //   };

  //   console.log("insert symbol")

  //   await this.ilpWriter.write(line);
  //   this.events.emitUpdate(symbol);
  // }

  /**
   * Bulk-insert символов через ILP (основной путь).
   * Здесь мы:
   *  - создаём пачку ILP-строк
   *  - задаём монотонно растущий timestamp, чтобы QuestDB не ругался
   *  - шлём всё одной пачкой → ~50× быстрее, чем SQL per-row
   */
  async insertMany(
    symbols: {
      name: string;
      baseAsset?: string;
      quoteAsset?: string;
      status?: string;
    }[],
    connectorType: string,
    marketType: string,
  ): Promise<SymbolEntity[]> {
    const now = Date.now();
    const baseTsNs = BigInt(now) * 1_000_000n; // базовый ts в наносекундах

    const entities: SymbolEntity[] = [];
    const lines: ILPWriteOptions[] = [];

    symbols.forEach((s, index) => {
      const entity: SymbolEntity = {
        symbol: s.name,
        baseAsset: s.baseAsset ?? '',
        quoteAsset: s.quoteAsset ?? '',
        status: s.status ?? '',
        connectorType,
        marketType,
        createdAt: now,
        updatedAt: now,
      };

      entities.push(entity);

      const ts = baseTsNs + BigInt(index); // монотонно растущий ts

      lines.push({
        table: 'symbols',
        keys: {
          symbol: entity.symbol,
          connectorType: entity.connectorType,
          marketType: entity.marketType,
        },
        fields: {
          baseAsset: entity.baseAsset,
          quoteAsset: entity.quoteAsset,
          status: entity.status,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
        },
        timestamp: Number(ts),
      });
    });

    console.log('insert lines');

    // 🔹 ОДИН bulk-запрос вместо тысяч SQL-INSERT
    await this.ilpWriter.writeMany(lines);

    // если тебе важно событие на каждый символ
    for (const entity of entities) {
      this.events.emitUpdate(entity);
    }

    return entities;
  }

  /** Полная перезапись символов */
  async replaceAll(
    symbols: {
      name: string;
      baseAsset?: string;
      quoteAsset?: string;
      status?: string;
    }[],
    connectorType: string,
    marketType: string,
  ): Promise<SymbolEntity[]> {
    // ⚠️ TRUNCATE полностью очищает таблицу, после него ограничения по порядку ts сбрасываются
    await this.deleteAll(connectorType, marketType);
    return this.insertMany(symbols, connectorType, marketType);
  }
}
