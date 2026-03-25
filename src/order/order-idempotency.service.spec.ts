import { OrderIdempotencyService } from './order-idempotency.service';

async function createWithIdempotency<T>(options: {
  service: OrderIdempotencyService;
  idempotencyKey?: string;
  execute: () => Promise<T>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}): Promise<T> {
  const { service, idempotencyKey, execute } = options;

  if (!idempotencyKey) {
    return execute();
  }

  const started = await service.tryStartProcessing(idempotencyKey);
  if (started) {
    const result = await execute();
    await service.setFinalResponse(idempotencyKey, result);
    return result;
  }

  const replay = await service.getFinalResponse<T>(idempotencyKey);
  if (replay) return replay;

  const replayAfterWait = await service.waitForFinalResponse<T>(
    idempotencyKey,
    {
      maxWaitMs: options.maxWaitMs ?? 1200,
      pollIntervalMs: options.pollIntervalMs ?? 100,
    },
  );
  if (replayAfterWait) return replayAfterWait;

  throw new Error('still_processing');
}

describe('OrderIdempotencyService', () => {
  const originalRedisHost = process.env.REDIS_HOST;
  const originalRedisPort = process.env.REDIS_PORT;
  const originalIdempotencyTtl = process.env.PROVIDER_ORDER_IDEMPOTENCY_TTL_MS;

  beforeEach(() => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.PROVIDER_ORDER_IDEMPOTENCY_TTL_MS;
  });

  afterAll(() => {
    if (originalRedisHost !== undefined)
      process.env.REDIS_HOST = originalRedisHost;
    if (originalRedisPort !== undefined)
      process.env.REDIS_PORT = originalRedisPort;
    if (originalIdempotencyTtl !== undefined) {
      process.env.PROVIDER_ORDER_IDEMPOTENCY_TTL_MS = originalIdempotencyTtl;
    }
  });

  it('same request twice returns same response and avoids duplicate execution', async () => {
    const service = new OrderIdempotencyService({
      ttlMs: 600000,
      lockTtlMs: 30000,
    });
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ id: 'order-1', status: 'ok' })
      .mockResolvedValueOnce({ id: 'order-2', status: 'ok' });

    const first = await createWithIdempotency({
      service,
      idempotencyKey: 'idem-same',
      execute,
    });
    const second = await createWithIdempotency({
      service,
      idempotencyKey: 'idem-same',
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('concurrent same key results in single execution', async () => {
    const service = new OrderIdempotencyService({
      ttlMs: 600000,
      lockTtlMs: 30000,
    });
    const result = { id: 'order-concurrent', status: 'ok' };
    const execute = jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return result;
    });

    const [first, second] = await Promise.all([
      createWithIdempotency({
        service,
        idempotencyKey: 'idem-concurrent',
        execute,
        maxWaitMs: 1000,
        pollIntervalMs: 20,
      }),
      createWithIdempotency({
        service,
        idempotencyKey: 'idem-concurrent',
        execute,
        maxWaitMs: 1000,
        pollIntervalMs: 20,
      }),
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('missing key preserves non-idempotent behavior', async () => {
    const service = new OrderIdempotencyService({
      ttlMs: 600000,
      lockTtlMs: 30000,
    });
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ id: 'order-a' })
      .mockResolvedValueOnce({ id: 'order-b' });

    const first = await createWithIdempotency({ service, execute });
    const second = await createWithIdempotency({ service, execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(first).not.toEqual(second);
  });

  it('TTL expiry allows new execution for the same key', async () => {
    process.env.PROVIDER_ORDER_IDEMPOTENCY_TTL_MS = '40';
    const service = new OrderIdempotencyService({ lockTtlMs: 30 });
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ id: 'order-ttl-1' })
      .mockResolvedValueOnce({ id: 'order-ttl-2' });

    const first = await createWithIdempotency({
      service,
      idempotencyKey: 'idem-ttl',
      execute,
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    const second = await createWithIdempotency({
      service,
      idempotencyKey: 'idem-ttl',
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect((first as any).id).toBe('order-ttl-1');
    expect((second as any).id).toBe('order-ttl-2');
  });
});
