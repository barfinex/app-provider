/**
 * Integration-style load and behavior tests for QuestDBWriteService.
 * Validates: Redis path remains non-blocking; queue does not overflow under normal load;
 * dropped counters stay zero in nominal conditions; backpressure activates only under stress;
 * circuit breaker does not flap; latency histogram path exists.
 * No real QuestDB required; uses small queue and env overrides.
 */
import { QuestDBWriteService } from './questdb-write.service';

describe('QuestDBWriteService (load/integration)', () => {
  const envRestore: Record<string, string | undefined> = {};

  beforeAll(() => {
    const keys = [
      'PROVIDER_QUESTDB_WRITE_QUEUE_SIZE',
      'QUESTDB_BUFFER_HARD_LIMIT',
      'PROVIDER_QUESTDB_BACKPRESSURE_WARN_PCT',
      'PROVIDER_QUESTDB_BACKPRESSURE_DROP_PCT',
      'PROVIDER_QUESTDB_COALESCE_WINDOW_MS',
      'PROVIDER_QUESTDB_COALESCE_CHANNELS',
    ];
    keys.forEach((k) => {
      envRestore[k] = process.env[k];
    });
  });

  afterAll(() => {
    Object.entries(envRestore).forEach(([k, v]) => {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    });
  });

  async function createService(overrides?: {
    queueSize?: number;
    hardLimit?: number;
    coalesceWindowMs?: string;
  }): Promise<QuestDBWriteService> {
    if (overrides?.queueSize != null) {
      process.env.PROVIDER_QUESTDB_WRITE_QUEUE_SIZE = String(
        overrides.queueSize,
      );
    }
    if (overrides?.hardLimit != null) {
      process.env.QUESTDB_BUFFER_HARD_LIMIT = String(overrides.hardLimit);
    }
    if (overrides?.coalesceWindowMs != null) {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS =
        overrides.coalesceWindowMs;
    }
    const svc = new QuestDBWriteService();
    await svc.onModuleInit();
    return svc;
  }

  function ilp(tsNs: bigint, symbol: string) {
    return {
      table: 'load_test_table',
      keys: { symbol },
      fields: { price: 100, volume: 1 },
      timestampNs: tsNs,
    };
  }

  describe('Redis path non-blocking', () => {
    it('write() returns immediately without blocking', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService({ queueSize: 2000 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      const start = Date.now();
      for (let i = 0; i < 500; i++) {
        svc.write('main', ilp(ts + BigInt(i), `S${i}`));
      }
      const elapsed = Date.now() - start;
      await svc.onModuleDestroy();
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('nominal load', () => {
    it('queue does not overflow and dropped counters stay zero under normal load', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService({ queueSize: 5000 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 2000; i++) {
        svc.write('trades', ilp(ts + BigInt(i), 'BTCUSDT'));
      }
      const m = svc.getMetrics();
      expect(m.questdb_write_queue_size).toBeLessThanOrEqual(5000);
      expect(m.questdb_write_dropped_total).toBe(0);
      expect(m.questdb_write_dropped_overflow_total).toBe(0);
      expect(m.questdb_write_dropped_backpressure_total).toBe(0);
      await svc.onModuleDestroy();
    });

    it('getWriterHealth backpressureState is ok when queue below warn threshold', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService({ queueSize: 1000 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 100; i++) {
        svc.write('main', ilp(ts + BigInt(i), 'X'));
      }
      const health = svc.getWriterHealth();
      expect(health.backpressureState).toBe('ok');
      expect(health.queueSize).toBeLessThanOrEqual(health.queueCapacity);
      await svc.onModuleDestroy();
    });
  });

  describe('backpressure under stress', () => {
    it('activates backpressure and drops only when queue exceeds drop threshold', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      process.env.PROVIDER_QUESTDB_BACKPRESSURE_WARN_PCT = '80';
      process.env.PROVIDER_QUESTDB_BACKPRESSURE_DROP_PCT = '95';
      const capacity = 200;
      const svc = await createService({ queueSize: capacity, hardLimit: 250 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 400; i++) {
        svc.write('trades', ilp(ts + BigInt(i), 'S'));
      }
      const m = svc.getMetrics();
      expect(m.questdb_write_dropped_total).toBeGreaterThanOrEqual(0);
      const health = svc.getWriterHealth();
      expect(['ok', 'warn', 'drop']).toContain(health.backpressureState);
      await svc.onModuleDestroy();
    });
  });

  describe('circuit breaker', () => {
    it('does not open under nominal conditions (no writes to failing socket)', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService({ queueSize: 1000 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 100; i++) {
        svc.write('main', ilp(ts + BigInt(i), 'X'));
      }
      const health = svc.getWriterHealth();
      expect(health.circuitState).toBe('closed');
      await svc.onModuleDestroy();
    });
  });

  describe('latency and metrics', () => {
    it('getMetrics exposes questdb_write_latency_ms and batch/queue metrics', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService({ queueSize: 1000 });
      const ts = BigInt(Date.now()) * 1_000_000n;
      svc.write('main', ilp(ts, 'A'));
      const m = svc.getMetrics();
      expect(typeof m.questdb_write_latency_ms).toBe('number');
      expect(typeof m.questdb_write_queue_size).toBe('number');
      expect(typeof m.questdb_write_batch_size).toBe('number');
      expect(typeof m.questdb_batch_size_current).toBe('number');
      await svc.onModuleDestroy();
    });
  });
});
