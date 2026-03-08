import { QuestDBWriteService } from './questdb-write.service';

describe('QuestDBWriteService', () => {
  const envRestore = {} as Record<string, string | undefined>;

  beforeAll(() => {
    const keys = [
      'PROVIDER_QUESTDB_WRITE_QUEUE_SIZE',
      'QUESTDB_BUFFER_HARD_LIMIT',
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

  async function createService(): Promise<QuestDBWriteService> {
    const svc = new QuestDBWriteService();
    await svc.onModuleInit();
    return svc;
  }

  function ilp(tsNs: bigint, symbol: string) {
    return {
      table: 'test_table',
      keys: { symbol },
      fields: { price: 100, volume: 1 },
      timestampNs: tsNs,
    };
  }

  describe('drop reason accounting', () => {
    it('exposes dropped-by-reason counters in getMetrics', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService();
      const m = svc.getMetrics();
      expect(typeof m.questdb_write_dropped_overflow_total).toBe('number');
      expect(typeof m.questdb_write_dropped_backpressure_total).toBe('number');
      expect(typeof m.questdb_write_dropped_shutdown_total).toBe('number');
      expect(m.questdb_write_dropped_overflow_total).toBe(0);
      expect(m.questdb_write_dropped_backpressure_total).toBe(0);
      expect(m.questdb_write_dropped_shutdown_total).toBe(0);
      await svc.onModuleDestroy();
    });

    it('counts shutdown buffer discard as shutdown reason', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService();
      const ts = BigInt(Date.now()) * 1_000_000n;
      svc.write('main', ilp(ts, 'A'));
      svc.write('main', ilp(ts + 1n, 'B'));
      const before = svc.getMetrics().questdb_write_dropped_shutdown_total;
      expect(before).toBe(0);
      await svc.onModuleDestroy();
      const m = svc.getMetrics();
      expect(m.questdb_write_dropped_shutdown_total).toBe(2);
      expect(m.questdb_write_dropped_total).toBeGreaterThanOrEqual(2);
    });
  });

  describe('coalescing per channel', () => {
    it('coalesces when channel is in COALESCE_CHANNELS', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '1';
      process.env.PROVIDER_QUESTDB_COALESCE_CHANNELS = 'candles';
      const svc = await createService();
      const ts = BigInt(Date.now()) * 1_000_000n;
      svc.write('candles', ilp(ts, 'BTCUSDT'));
      svc.write('candles', { ...ilp(ts, 'BTCUSDT'), fields: { price: 101, volume: 2 } });
      await new Promise((r) => setTimeout(r, 5));
      await svc.flushOnce();
      const m = svc.getMetrics();
      expect(m.questdb_write_queue_size).toBe(1);
      await svc.onModuleDestroy();
    });

    it('does not coalesce when channel is not in COALESCE_CHANNELS', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '1';
      process.env.PROVIDER_QUESTDB_COALESCE_CHANNELS = 'candles';
      const svc = await createService();
      const ts = BigInt(Date.now()) * 1_000_000n;
      svc.write('trades', ilp(ts, 'BTCUSDT'));
      svc.write('trades', ilp(ts + 1n, 'BTCUSDT'));
      await svc.flushOnce();
      const m = svc.getMetrics();
      expect(m.questdb_write_queue_size).toBe(2);
      await svc.onModuleDestroy();
    });
  });

  describe('getWriterHealth', () => {
    it('returns snapshot with queueSize, queueCapacity, circuitState, backpressureState, batchSizeCurrent', async () => {
      process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS = '0';
      const svc = await createService();
      const ts = BigInt(Date.now()) * 1_000_000n;
      svc.write('main', ilp(ts, 'X'));
      const health = svc.getWriterHealth();
      expect(health.queueSize).toBe(1);
      expect(health.queueCapacity).toBeGreaterThanOrEqual(1000);
      expect(health.circuitState).toBe('closed');
      expect(health.backpressureState).toBe('ok');
      expect(typeof health.reconnectAttempts).toBe('number');
      expect(typeof health.batchSizeCurrent).toBe('number');
      await svc.onModuleDestroy();
    });
  });
});
