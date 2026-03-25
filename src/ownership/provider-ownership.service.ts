import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IOwnershipStore } from './ownership-store.interface';
import { Inject } from '@nestjs/common';
import { OWNERSHIP_STORE } from './ownership-store.interface';
import {
  OwnershipScope,
  ownershipScopeKey,
  parseOwnershipKeyToScope,
  OwnershipRecord,
  OwnershipState,
  ClaimResult,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from './ownership.types';
import { ProviderInstanceService } from './provider-instance.service';

interface ScopeState {
  state: OwnershipState;
  fencingToken: number;
  record: OwnershipRecord | null;
  heartbeatTimer: NodeJS.Timeout | null;
}

@Injectable()
export class ProviderOwnershipService implements OnModuleDestroy {
  private readonly logger = new Logger(ProviderOwnershipService.name);
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly scopeState = new Map<string, ScopeState>();
  private readonly ownershipListeners: Array<
    (scope: OwnershipScope, state: OwnershipState) => void
  > = [];

  constructor(
    @Inject(OWNERSHIP_STORE) private readonly store: IOwnershipStore,
    private readonly instance: ProviderInstanceService,
    private readonly configService: ConfigService,
  ) {
    this.leaseDurationMs = Math.max(
      5_000,
      Number(
        this.configService.get('PROVIDER_OWNERSHIP_LEASE_MS') ??
          DEFAULT_LEASE_DURATION_MS,
      ),
    );
    this.heartbeatIntervalMs = Math.max(
      1_000,
      Number(
        this.configService.get('PROVIDER_OWNERSHIP_HEARTBEAT_MS') ??
          DEFAULT_HEARTBEAT_INTERVAL_MS,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const [key, scopeState] of this.scopeState) {
      if (scopeState.heartbeatTimer) {
        clearInterval(scopeState.heartbeatTimer);
        scopeState.heartbeatTimer = null;
      }
      if (scopeState.state === 'ACTIVE' && scopeState.record) {
        await this.store.release(
          key,
          this.instance.providerInstanceId,
          scopeState.fencingToken,
        );
        this.logger.log(`ProviderOwnership released scope=${key} on shutdown`);
      }
    }
    this.scopeState.clear();
  }

  /**
   * Claim ownership of a dataset scope. Call before starting ingestion.
   * Returns claim result with fencing token on success.
   * Waits for store readiness (e.g. Redis connected) before claiming to avoid startup race.
   */
  async claim(scope: OwnershipScope): Promise<ClaimResult> {
    if (this.store.whenReady) {
      await this.store.whenReady();
    }
    const key = ownershipScopeKey(scope);
    const existing = this.scopeState.get(key);
    if (existing?.heartbeatTimer) {
      clearInterval(existing.heartbeatTimer);
      existing.heartbeatTimer = null;
    }

    const result = await this.store.claim(
      key,
      this.instance.providerInstanceId,
      this.leaseDurationMs,
    );
    if (!result.success) {
      const state: ScopeState = {
        state: result.current ? 'LOST' : 'UNOWNED',
        fencingToken: 0,
        record: result.current ?? null,
        heartbeatTimer: null,
      };
      this.scopeState.set(key, state);
      this.emitState(scope, state.state);
      if (result.current) {
        this.logger.log(
          `ProviderOwnership scope=${key} already owned by another instance (owner=${result.current.ownerInstanceId}); this instance did not acquire ownership (current=${this.instance.providerInstanceId})`,
        );
      }
      return {
        success: false,
        record: result.current,
        reason: result.current ? 'already_owned' : 'claim_failed',
      };
    }

    const token = result.fencingToken ?? 1;
    const record: OwnershipRecord = {
      ownershipKey: key,
      ownerInstanceId: this.instance.providerInstanceId,
      fencingToken: token,
      leaseExpiresAt: Date.now() + this.leaseDurationMs,
      lastHeartbeat: Date.now(),
    };
    const scopeState: ScopeState = {
      state: 'ACTIVE',
      fencingToken: token,
      record,
      heartbeatTimer: null,
    };
    this.scopeState.set(key, scopeState);
    this.emitState(scope, 'ACTIVE');

    this.logger.log(
      `ProviderOwnership acquired scope=${key} owner=${this.instance.providerInstanceId} fencingToken=${token}`,
    );

    scopeState.heartbeatTimer = setInterval(
      () => this.heartbeat(scope),
      this.heartbeatIntervalMs,
    );

    return { success: true, fencingToken: token, record };
  }

  private async heartbeat(scope: OwnershipScope): Promise<void> {
    const key = ownershipScopeKey(scope);
    const scopeState = this.scopeState.get(key);
    if (
      !scopeState ||
      scopeState.state !== 'ACTIVE' ||
      !scopeState.heartbeatTimer
    )
      return;

    const renewed = await this.store.renew(
      key,
      this.instance.providerInstanceId,
      scopeState.fencingToken,
      this.leaseDurationMs,
    );
    if (!renewed) {
      clearInterval(scopeState.heartbeatTimer);
      scopeState.heartbeatTimer = null;
      scopeState.state = 'DRAINING';
      scopeState.record = await this.store.get(key);
      this.emitState(scope, 'DRAINING');
      this.logger.log(
        `ProviderOwnership fenced localOwner=${this.instance.providerInstanceId} token=${scopeState.fencingToken} scope=${key}`,
      );
      this.logger.log(`ProviderOwnership draining scope=${key}`);
      return;
    }
    scopeState.record = scopeState.record
      ? {
          ...scopeState.record,
          lastHeartbeat: Date.now(),
          leaseExpiresAt: Date.now() + this.leaseDurationMs,
        }
      : null;
    this.logger.debug(
      `ProviderOwnership renewed scope=${key} owner=${this.instance.providerInstanceId}`,
    );
  }

  /**
   * Release ownership (e.g. on graceful shutdown or before stopping ingestion).
   */
  async release(scope: OwnershipScope): Promise<boolean> {
    const key = ownershipScopeKey(scope);
    const scopeState = this.scopeState.get(key);
    if (!scopeState) return true;
    if (scopeState.heartbeatTimer) {
      clearInterval(scopeState.heartbeatTimer);
      scopeState.heartbeatTimer = null;
    }
    let released = true;
    if (scopeState.state === 'ACTIVE' && scopeState.record) {
      released = await this.store.release(
        key,
        this.instance.providerInstanceId,
        scopeState.fencingToken,
      );
    }
    scopeState.state = 'UNOWNED';
    scopeState.fencingToken = 0;
    scopeState.record = null;
    this.emitState(scope, 'UNOWNED');
    return released;
  }

  /**
   * Assert that this instance still owns the scope with the given fencing token.
   * Call before any ingestion write. If invalid, transitions to DRAINING and returns false.
   */
  assertOwnership(scope: OwnershipScope, fencingToken: number): boolean {
    const key = ownershipScopeKey(scope);
    const scopeState = this.scopeState.get(key);
    if (!scopeState) return false;
    if (scopeState.state !== 'ACTIVE') return false;
    if (scopeState.fencingToken !== fencingToken) {
      scopeState.state = 'DRAINING';
      this.emitState(scope, 'DRAINING');
      this.logger.warn(
        `ProviderOwnership fenced localOwner=${this.instance.providerInstanceId} token=${fencingToken} scope=${key} (token mismatch)`,
      );
      return false;
    }
    return true;
  }

  /**
   * Get current local state and record for a scope.
   */
  getScopeState(scope: OwnershipScope): {
    state: OwnershipState;
    fencingToken: number;
    record: OwnershipRecord | null;
  } {
    const key = ownershipScopeKey(scope);
    const s = this.scopeState.get(key);
    if (!s) {
      return { state: 'UNOWNED', fencingToken: 0, record: null };
    }
    return { state: s.state, fencingToken: s.fencingToken, record: s.record };
  }

  /**
   * Get current fencing token for a scope if we are ACTIVE; otherwise 0.
   */
  getFencingToken(scope: OwnershipScope): number {
    return this.getScopeState(scope).fencingToken;
  }

  /**
   * Check if this instance is currently the active owner for the scope.
   */
  isActiveOwner(scope: OwnershipScope): boolean {
    return this.getScopeState(scope).state === 'ACTIVE';
  }

  /**
   * Get ownership record from store (authoritative); optional scope filter.
   */
  async getOwnershipRecord(
    scope: OwnershipScope,
  ): Promise<OwnershipRecord | null> {
    return this.store.get(ownershipScopeKey(scope));
  }

  /**
   * List all scopes this instance tracks (for diagnostics).
   * Supports both non-shard keys (BINANCE:SPOT) and shard keys (BINANCE:SPOT:shard0).
   */
  getTrackedScopes(): OwnershipScope[] {
    const scopes: OwnershipScope[] = [];
    for (const key of this.scopeState.keys()) {
      scopes.push(parseOwnershipKeyToScope(key));
    }
    return scopes;
  }

  /**
   * True if this instance is active owner for the given connector+market, either as a whole scope
   * (when sharding disabled) or for any shard of that scope (when sharding enabled).
   */
  isActiveOwnerForConnectorMarket(
    connectorType: string,
    marketType: string,
  ): boolean {
    const prefix = `${String(connectorType).toUpperCase()}:${String(
      marketType,
    ).toUpperCase()}`;
    for (const key of this.scopeState.keys()) {
      if (key === prefix || key.startsWith(prefix + ':')) {
        const s = this.scopeState.get(key);
        if (s?.state === 'ACTIVE') return true;
      }
    }
    return false;
  }

  /**
   * List all ownership keys from store (for GET /provider/runtime/ownership).
   */
  async listAllOwnerships(): Promise<OwnershipRecord[]> {
    const listKeys = this.store.listKeys?.bind(this.store);
    if (!listKeys) return [];
    const keys = await listKeys('');
    const out: OwnershipRecord[] = [];
    for (const k of keys) {
      const r = await this.store.get(k);
      if (r) out.push(r);
    }
    return out;
  }

  /** Subscribe to state changes (e.g. for triggering drain/unsubscribe). */
  onStateChange(
    listener: (scope: OwnershipScope, state: OwnershipState) => void,
  ): () => void {
    this.ownershipListeners.push(listener);
    return () => {
      const i = this.ownershipListeners.indexOf(listener);
      if (i >= 0) this.ownershipListeners.splice(i, 1);
    };
  }

  private emitState(scope: OwnershipScope, state: OwnershipState): void {
    for (const fn of this.ownershipListeners) {
      try {
        fn(scope, state);
      } catch (e) {
        this.logger.warn(
          `Ownership state listener error: ${(e as Error)?.message}`,
        );
      }
    }
  }
}
