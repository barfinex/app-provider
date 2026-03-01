import { Injectable } from '@nestjs/common';

/**
 * Гейт подкачки истории: пока для пары (connectorType, marketType) идёт warmup по HTTP,
 * TCP-записи свечей для этой пары не выполняются (чёткое разделение HTTP подкачки и TCP realtime).
 */
@Injectable()
export class CandleWarmupGateService {
  private readonly runningKeys = new Set<string>();

  /** Set by CandleSyncService: false while warmup runs, true after all symbols history completed. */
  private warmupCompleted = false;

  setWarmupCompleted(completed: boolean): void {
    this.warmupCompleted = completed;
  }

  /** true = HTTP history warmup has completed for current key; safe to start realtime. */
  isWarmupCompleted(): boolean {
    return this.warmupCompleted;
  }

  private key(connectorType: string, marketType: string): string {
    return `${connectorType}:${marketType}`;
  }

  setWarmupRunning(connectorType: string, marketType: string, running: boolean): void {
    const k = this.key(connectorType, marketType);
    if (running) {
      this.runningKeys.add(k);
    } else {
      this.runningKeys.delete(k);
    }
  }

  /** true = идёт подкачка по HTTP для данной пары, TCP писать не надо */
  isWarmupRunning(connectorType: string, marketType: string): boolean {
    return this.runningKeys.has(this.key(connectorType, marketType));
  }

  /** true = идёт подкачка хотя бы по одному инструменту; пока true — TCP ILP не выполнять. */
  isAnyWarmupRunning(): boolean {
    return this.runningKeys.size > 0;
  }
}
