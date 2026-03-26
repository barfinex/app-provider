import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OwnershipScope } from './ownership.types';

/**
 * Metadata for a symbol shard (connector + market + shard id and assigned symbols).
 * Used for observability and scaling.
 */
export interface InstrumentShard {
  connectorType: string;
  marketType: string;
  shardId: number;
  symbols: string[];
}

/**
 * Deterministic symbol-to-shard assignment and local-shard filtering.
 * When PROVIDER_SYMBOL_SHARDING_ENABLED=false, all symbols are considered "in local shard"
 * and scope remains connector+market only (backward compatible).
 */
@Injectable()
export class InstrumentShardService {
  private readonly enabled: boolean;
  private readonly shardCount: number;
  private readonly localShardIds: number[];

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      String(
        this.configService.get('PROVIDER_SYMBOL_SHARDING_ENABLED') ?? 'false',
      ).toLowerCase() === 'true';
    this.shardCount = Math.max(
      1,
      Number(this.configService.get('PROVIDER_SYMBOL_SHARD_COUNT') ?? 4),
    );

    const idsRaw = this.configService.get('PROVIDER_SYMBOL_SHARD_IDS') as
      | string
      | undefined;
    if (this.enabled && typeof idsRaw === 'string' && idsRaw.trim() !== '') {
      this.localShardIds = idsRaw
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < this.shardCount);
      if (this.localShardIds.length === 0) {
        this.localShardIds = Array.from(
          { length: this.shardCount },
          (_, i) => i,
        );
      }
    } else {
      this.localShardIds = Array.from({ length: this.shardCount }, (_, i) => i);
    }
  }

  /** Whether symbol sharding is enabled (ownership scope = connector + market + shardId). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Total number of shards for the connector+market. */
  getShardCount(): number {
    return this.shardCount;
  }

  /** Shard IDs this instance is responsible for (when sharding enabled). When disabled, returns []. */
  getLocalShardIds(): number[] {
    return this.enabled ? [...this.localShardIds] : [];
  }

  /**
   * Deterministic shard for a symbol: hash(symbol) % shardCount.
   * Stable distribution and predictable ownership.
   */
  getShardId(symbol: string): number {
    const normalized = String(symbol ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) return 0;
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const c = normalized.charCodeAt(i);
      hash = (hash * 31 + c) >>> 0;
    }
    return Math.abs(hash) % this.shardCount;
  }

  /**
   * True if this instance should ingest the symbol (when sharding disabled, always true).
   * When enabled, true iff the symbol's shard is in localShardIds.
   */
  isSymbolInLocalShard(
    symbol: string,
    _connectorType?: string,
    _marketType?: string,
  ): boolean {
    if (!this.enabled) return true;
    const shardId = this.getShardId(symbol);
    return this.localShardIds.includes(shardId);
  }

  /**
   * Scope to use for ownership/fencing for a given symbol.
   * When sharding disabled: { connectorType, marketType }.
   * When enabled: { connectorType, marketType, shardId }.
   */
  getScopeForSymbol(
    symbol: string,
    connectorType: string,
    marketType: string,
  ): OwnershipScope {
    const scope: OwnershipScope = {
      connectorType: String(connectorType).toUpperCase(),
      marketType: String(marketType).toUpperCase(),
    };
    if (this.enabled) {
      scope.shardId = this.getShardId(symbol);
    }
    return scope;
  }

  /**
   * Build shard metadata for a connector+market and list of symbols (for runtime/shards endpoint).
   */
  getShardsMetadata(
    connectorType: string,
    marketType: string,
    symbols: string[],
  ): InstrumentShard[] {
    if (!this.enabled || this.shardCount <= 0) return [];

    const byShard = new Map<number, string[]>();
    for (let i = 0; i < this.shardCount; i++) {
      byShard.set(i, []);
    }
    for (const s of symbols) {
      const name = String(s).trim().toUpperCase();
      if (!name) continue;
      const id = this.getShardId(name);
      byShard.get(id)?.push(name);
    }

    return Array.from(byShard.entries())
      .filter(([, syms]) => syms.length > 0)
      .map(([shardId, syms]) => ({
        connectorType,
        marketType,
        shardId,
        symbols: syms.sort(),
      }));
  }
}
