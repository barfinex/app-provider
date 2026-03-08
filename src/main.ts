import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestMethod, ValidationPipe, type LogLevel } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { applyProviderWsAdapter } from '@barfinex/provider-ws-bridge';

import * as dotenv from 'dotenv';
import { resolve } from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const PROVIDER_BOOTSTRAP_GUARD = '__BARFINEX_PROVIDER_BOOTSTRAP_STARTED__';
const PROVIDER_ERROR_GUARD = '__BARFINEX_PROVIDER_ERROR_GUARD_INSTALLED__';
const PROVIDER_BOOTSTRAP_RETRY_BASE_MS = Math.max(
  1000,
  Number(process.env.PROVIDER_BOOTSTRAP_RETRY_BASE_MS || 2_000),
);
const PROVIDER_BOOTSTRAP_RETRY_MAX_MS = Math.max(
  PROVIDER_BOOTSTRAP_RETRY_BASE_MS,
  Number(process.env.PROVIDER_BOOTSTRAP_RETRY_MAX_MS || 30_000),
);

function resolveNestLoggerLevels(): LogLevel[] {
  const level = String(process.env.LOG_LEVEL || 'log').trim().toLowerCase();
  switch (level) {
    case 'debug':
      return ['log', 'warn', 'error', 'debug'];
    case 'warn':
      return ['warn', 'error'];
    case 'error':
      return ['error'];
    case 'log':
    default:
      return ['log', 'warn', 'error'];
  }
}

function isAddrInUseError(value: unknown): value is { code: string; message?: string } {
  if (!value || typeof value !== 'object') return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code === 'EADDRINUSE';
}

function installRecoverableErrorGuards(): void {
  const guardGlobal = globalThis as typeof globalThis & {
    [PROVIDER_ERROR_GUARD]?: boolean;
  };
  if (guardGlobal[PROVIDER_ERROR_GUARD]) return;
  guardGlobal[PROVIDER_ERROR_GUARD] = true;

  process.on('uncaughtException', (error: unknown) => {
    if (isAddrInUseError(error)) {
      console.warn(
        '[Provider bootstrap] Suppressed uncaught EADDRINUSE (port recovery will retry).',
      );
      return;
    }
    console.error('[Provider bootstrap] Uncaught exception (runtime continues):', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    if (isAddrInUseError(reason)) {
      console.warn(
        '[Provider bootstrap] Suppressed unhandled EADDRINUSE rejection (port recovery will retry).',
      );
      return;
    }
    console.error('[Provider bootstrap] Unhandled rejection (runtime continues):', reason);
  });
}

function releasePortListenersWindows(port: number): number[] {
  if (process.platform !== 'win32') return [];

  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const lines = String(output)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const pids = new Set<number>();
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.split(/\s+/);
      const pidRaw = parts[parts.length - 1];
      const pid = Number(pidRaw);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      pids.add(pid);
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Ignore races where the process exits between netstat and taskkill.
      }
    }

    return Array.from(pids);
  } catch {
    return [];
  }
}

function getPortListenersWindows(port: number): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const lines = String(output)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const pids = new Set<number>();
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.split(/\s+/);
      const pidRaw = parts[parts.length - 1];
      const pid = Number(pidRaw);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      pids.add(pid);
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

async function ensurePortFreeDev(port: number): Promise<void> {
  const timeoutMs = 15_000;
  const stepMs = 400;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const listeners = getPortListenersWindows(port);
    if (listeners.length === 0) return;

    const killed = releasePortListenersWindows(port);
    if (killed.length > 0) {
      console.warn(
        `[Provider bootstrap] Freed port ${port} by stopping PID(s): ${killed.join(', ')}`,
      );
    }

    await new Promise(resolveDelay => setTimeout(resolveDelay, stepMs));
  }
}

async function listenWithPortRecovery(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  port: number,
): Promise<void> {
  const host = '0.0.0.0';
  const isDev = process.env.NODE_ENV !== 'production';
  const maxAttempts = isDev ? 5 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await app.listen(port, host);
      return;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') {
        throw err;
      }

      const isLastAttempt = attempt >= maxAttempts;
      if (!isDev || isLastAttempt) {
        throw new Error(
          `Port ${port} is already in use after ${attempt} attempt(s). Stop conflicting process or free the port.`,
        );
      }

      console.warn(
        `[Provider bootstrap] Port ${port} busy on attempt ${attempt}/${maxAttempts}; trying to free and retry...`,
      );
      await ensurePortFreeDev(port);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
  }
}

// 👇 Сначала база .env, затем .env.{APP_MODE} (переменные из второго перезаписывают)
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

async function bootstrap() {
  installRecoverableErrorGuards();

  // 👇 Опции для HTTPS (если заданы SSL_CERT и SSL_KEY в .env)
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    try {
      httpsOptions = {
        key: fs.readFileSync(resolve(process.cwd(), process.env.SSL_KEY)),
        cert: fs.readFileSync(resolve(process.cwd(), process.env.SSL_CERT)),
      };
      console.log('✅ HTTPS включён (сертификаты загружены)');
    } catch (e: any) {
      console.warn(
        `⚠️ Не удалось загрузить сертификаты (${process.env.SSL_KEY}, ${process.env.SSL_CERT}):`,
        e.message,
      );
    }
  }

  const app = await NestFactory.create(AppModule, {
    httpsOptions,
    logger: resolveNestLoggerLevels(),
  });
  app.enableShutdownHooks();

  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe());

  // 👇 Читаем CORS_ORIGINS из env
  const origins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  app.enableCors({
    origin: origins,
    credentials: true,
  });

  // Принудительно ставим Socket.IO path = /ws для единообразного клиента.
  applyProviderWsAdapter(app, {
    path: '/ws',
    cors: { origin: origins, credentials: true },
  });

  // 👇 Swagger
  const config = new DocumentBuilder()
    .setTitle('Barfinex.com Provider API')
    .setDescription(
      'This allows seamless interaction with multiple trading platforms through connectors. ' +
      'It offers methods for authentication, market data retrieval, order placement and cancellation, ' +
      'portfolio management, notifications, and account management. This API streamlines ' +
      'the development and integration of trading strategies and applications. ' +
      'Security: all /api/* endpoints require provider API token from config.provider.apiToken. ' +
      'Send it as Authorization: Bearer <token> or x-api-token header.',
    )
    .setVersion('1.0')
    .addTag('Connectors', 'Retrieve available market data providers...')
    .addTag('Detectors', 'Advanced algorithms for identifying market patterns...')
    .addTag('Inspectors', 'Risk management services in a trading system...')
    .addTag('Accounts', 'Get user account information...')
    .addTag('Orders', 'Place new buy/sell orders...')
    .addTag('Candles', 'Obtain historical candlestick data...')
    .addTag('Products', 'Access information about available trading products...')
    .addTag('Subscriptions', 'Subscribe to notifications about market events...')
    .addTag('Assets', 'Retrieve information about available assets...')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Token',
        name: 'ProviderApiToken',
        description:
          'Required for all /api/* endpoints. Use Authorization: Bearer <token> (same as config.provider.apiToken).',
        in: 'header',
      },
      'ProviderApiToken',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  let shuttingDown = false;
  const closeApp = async (
    signal: NodeJS.Signals,
    options?: { reemitSignal?: boolean; exitCode?: number },
  ) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      // no-op: process is shutting down anyway
    } finally {
      // On Windows, re-emitting SIGUSR2 is unreliable and can make nodemon
      // report "app crashed" even for graceful restarts.
      if (options?.reemitSignal && process.platform !== 'win32') {
        try {
          process.kill(process.pid, signal);
          return;
        } catch (error) {
          console.warn(
            `[Provider bootstrap] Failed to re-emit ${signal}; falling back to clean exit: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (typeof options?.exitCode === 'number') {
        process.exit(options.exitCode);
      }
    }
  };

  // Nodemon uses SIGUSR2 during restarts; close HTTP server first to avoid EADDRINUSE.
  process.once('SIGUSR2', () => {
    void closeApp('SIGUSR2', { reemitSignal: true }).catch(error => {
      console.warn(
        `[Provider bootstrap] SIGUSR2 shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  process.once('SIGINT', () => {
    void closeApp('SIGINT', { exitCode: 0 }).catch(error => {
      console.warn(
        `[Provider bootstrap] SIGINT shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    });
  });
  process.once('SIGTERM', () => {
    void closeApp('SIGTERM', { exitCode: 0 }).catch(error => {
      console.warn(
        `[Provider bootstrap] SIGTERM shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    });
  });

  const PORT = Number(process.env.PROVIDER_API_PORT || 8081);
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    await ensurePortFreeDev(PORT);
  }

  await listenWithPortRecovery(app, PORT);

  const proto = httpsOptions ? 'https' : 'http';
  console.log(`🚀 Provider API is running on: ${proto}://localhost:${PORT}/api`);
  console.log(`📑 Documentation: ${proto}://localhost:${PORT}/docs`);
  console.log(`🔌 WebSocket (Socket.IO) at: ${proto}://localhost:${PORT}/ws`);
}
const globalWithBootstrapGuard = globalThis as typeof globalThis & {
  [PROVIDER_BOOTSTRAP_GUARD]?: boolean;
};
let bootstrapRetryAttempt = 0;
let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Treat infrastructure connection errors as retriable (do not treat as permanent failure). */
function isRetriableBootstrapError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('connection reset') ||
    msg.includes('connection refused') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout')
  );
}

function scheduleBootstrapRetry(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  const retriable = isRetriableBootstrapError(error);
  const delayMs = Math.min(
    PROVIDER_BOOTSTRAP_RETRY_BASE_MS * Math.pow(2, Math.min(bootstrapRetryAttempt, 8)),
    PROVIDER_BOOTSTRAP_RETRY_MAX_MS,
  );
  bootstrapRetryAttempt += 1;

  console.error(
    `[Provider bootstrap] Fatal startup error (attempt=${bootstrapRetryAttempt}): ${message}`,
  );
  if (retriable) {
    console.warn(
      '[Provider bootstrap] Infrastructure connection error (QuestDB/Redis). Retrying is expected until services are up.',
    );
  }
  if (bootstrapRetryTimer) return;

  console.warn(
    `[Provider bootstrap] scheduling startup retry in ${delayMs}ms (base=${PROVIDER_BOOTSTRAP_RETRY_BASE_MS}, max=${PROVIDER_BOOTSTRAP_RETRY_MAX_MS})`,
  );
  bootstrapRetryTimer = setTimeout(() => {
    bootstrapRetryTimer = null;
    void bootstrap()
      .then(() => {
        bootstrapRetryAttempt = 0;
      })
      .catch(scheduleBootstrapRetry);
  }, delayMs);
}

if (!globalWithBootstrapGuard[PROVIDER_BOOTSTRAP_GUARD]) {
  globalWithBootstrapGuard[PROVIDER_BOOTSTRAP_GUARD] = true;
  void bootstrap()
    .then(() => {
      bootstrapRetryAttempt = 0;
    })
    .catch(scheduleBootstrapRetry);
} else {
  console.warn('Provider bootstrap skipped: already started in this process.');
}
