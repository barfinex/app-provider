import { OwnershipRecord } from './ownership.types';

/**
 * Pluggable store for ownership records.
 * Implementations must support atomic claim/renew/release for fencing.
 */
export interface IOwnershipStore {
  /**
   * Claim ownership for a key. Only succeeds if key is unset or lease expired.
   * Returns new fencing token on success.
   */
  claim(
    ownershipKey: string,
    ownerInstanceId: string,
    leaseDurationMs: number,
  ): Promise<{
    success: boolean;
    fencingToken?: number;
    current?: OwnershipRecord;
  }>;

  /**
   * Renew lease (heartbeat). Only succeeds if current owner and token match.
   */
  renew(
    ownershipKey: string,
    ownerInstanceId: string,
    fencingToken: number,
    leaseDurationMs: number,
  ): Promise<boolean>;

  /**
   * Release ownership. Only succeeds if current owner and token match.
   */
  release(
    ownershipKey: string,
    ownerInstanceId: string,
    fencingToken: number,
  ): Promise<boolean>;

  /**
   * Get current ownership record (if any).
   */
  get(ownershipKey: string): Promise<OwnershipRecord | null>;

  /**
   * List all ownership keys (optional; for diagnostics).
   */
  listKeys?(prefix: string): Promise<string[]>;

  /**
   * Resolves when the store is ready for claim/renew/release (e.g. Redis connected).
   * Optional; if not implemented, callers assume the store is ready after module init.
   */
  whenReady?(): Promise<void>;
}

export const OWNERSHIP_STORE = 'OWNERSHIP_STORE';
