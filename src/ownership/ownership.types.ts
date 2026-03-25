/**
 * Ownership types for lease-based ingestion coordination.
 * Supports rolling upgrades and multi-instance safe handover.
 */

/** Scope of ingestion ownership (connector + market; optional shard for symbol-level sharding). */
export interface OwnershipScope {
  connectorType: string;
  marketType: string;
  /** Optional: symbol shard id when PROVIDER_SYMBOL_SHARDING_ENABLED. Enables horizontal scaling per shard. */
  shardId?: number;
  /** Optional: future extension e.g. "trades" | "orderbook" | "candles" */
  datasetType?: string;
  /** Optional: future symbol-level ownership */
  symbol?: string;
}

/** Stable key for a scope: CONNECTOR:MARKET, CONNECTOR:MARKET:shard0, or CONNECTOR:MARKET:datasetType:symbol */
export function ownershipScopeKey(scope: OwnershipScope): string {
  const parts = [scope.connectorType, scope.marketType];
  if (scope.shardId !== undefined && scope.shardId !== null) {
    parts.push(`shard${scope.shardId}`);
  }
  if (scope.datasetType) parts.push(scope.datasetType);
  if (scope.symbol) parts.push(scope.symbol);
  return parts.join(':').toUpperCase();
}

/**
 * Parse an ownership key back to scope (e.g. BINANCE:SPOT or BINANCE:SPOT:shard0).
 * Used by runtime and getTrackedScopes to support shard keys.
 */
export function parseOwnershipKeyToScope(key: string): OwnershipScope {
  const parts = key.split(':').map((p) => p.trim());
  const connectorType = (parts[0] ?? '').toUpperCase();
  const marketType = (parts[1] ?? '').toUpperCase();
  const scope: OwnershipScope = { connectorType, marketType };
  const third = parts[2];
  if (third !== undefined && /^shard\d+$/i.test(third)) {
    scope.shardId = parseInt(third.replace(/^shard/i, ''), 10);
  }
  return scope;
}

/** Ownership record stored in shared storage. */
export interface OwnershipRecord {
  ownershipKey: string;
  ownerInstanceId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  lastHeartbeat: number;
}

/** Local runtime state for an ownership scope on this instance. */
export type OwnershipState =
  | 'UNOWNED' // No ownership attempted or released
  | 'STANDBY' // Waiting to claim or not active
  | 'ACTIVE' // We own and are ingesting
  | 'DRAINING' // Lost ownership or fencing failed; stopping ingestion
  | 'LOST'; // Ownership was taken by another instance

/** Result of attempting to claim ownership. */
export interface ClaimResult {
  success: boolean;
  fencingToken?: number;
  record?: OwnershipRecord;
  reason?: string;
}

/** Lease parameters (configurable via env). */
export interface LeaseParams {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
}

export const DEFAULT_LEASE_DURATION_MS = 10_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3_000;
