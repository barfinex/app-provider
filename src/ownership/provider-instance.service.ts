import { Injectable } from '@nestjs/common';
import { hostname } from 'os';

const BOOT_TIMESTAMP = Date.now();

/**
 * Generates and exposes a unique identity for this Provider instance.
 * Used for ownership tracking and fencing.
 */
@Injectable()
export class ProviderInstanceService {
  /** Unique id: provider-${hostname}-${pid}-${bootTimestamp} */
  readonly providerInstanceId: string;
  /** Hostname (for logs/UI). */
  readonly hostname: string;
  /** Process id. */
  readonly pid: number;
  /** Boot time (ms since epoch). */
  readonly bootTimestamp: number;

  constructor() {
    this.hostname = hostname();
    this.pid = typeof process.pid === 'number' ? process.pid : 0;
    this.bootTimestamp = BOOT_TIMESTAMP;
    this.providerInstanceId = `provider-${this.hostname}-${this.pid}-${this.bootTimestamp}`;
  }

  /** Runtime metadata for diagnostics and ownership records. */
  getRuntimeMetadata(): {
    providerInstanceId: string;
    hostname: string;
    pid: number;
    bootTimestamp: number;
    uptimeMs: number;
  } {
    return {
      providerInstanceId: this.providerInstanceId,
      hostname: this.hostname,
      pid: this.pid,
      bootTimestamp: this.bootTimestamp,
      uptimeMs: Date.now() - this.bootTimestamp,
    };
  }
}
