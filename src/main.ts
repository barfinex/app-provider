import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  Logger,
  RequestMethod,
  ValidationPipe,
  type LogLevel,
} from '@nestjs/common';
import { ProviderBootstrapService } from './runtime/provider-bootstrap.service';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { applyProviderWsAdapter } from '@barfinex/provider-ws-bridge';
import { ConfigService } from '@barfinex/config';

import * as dotenv from 'dotenv';
import { resolve } from 'path';
import * as fs from 'fs';

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
/** After nodemon restart the old process may still hold the port. Retry listen a few times with short delay. */
const EADDRINUSE_RETRY_ATTEMPTS = Number(
  process.env.PROVIDER_EADDRINUSE_RETRY_ATTEMPTS || 5,
);
const EADDRINUSE_RETRY_DELAY_MS = Number(
  process.env.PROVIDER_EADDRINUSE_RETRY_DELAY_MS || 1500,
);

function resolveNestLoggerLevels(): LogLevel[] {
  const level = String(process.env.LOG_LEVEL || 'log')
    .trim()
    .toLowerCase();
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

function installRecoverableErrorGuards(): void {
  const guardGlobal = globalThis as typeof globalThis & {
    [PROVIDER_ERROR_GUARD]?: boolean;
  };
  if (guardGlobal[PROVIDER_ERROR_GUARD]) return;
  guardGlobal[PROVIDER_ERROR_GUARD] = true;

  process.on('uncaughtException', (error: unknown) => {
    console.error(
      '[Provider bootstrap] Uncaught exception (runtime continues):',
      error,
    );
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error(
      '[Provider bootstrap] Unhandled rejection (runtime continues):',
      reason,
    );
  });

  process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    process.stderr.write(
      `[Provider bootstrap] process.exit code=${code} signal=${signal}\n`,
    );
  });
}

// 👇 Сначала база .env, затем .env.{APP_MODE} (переменные из второго перезаписывают)
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

const PROVIDER_STARTUP_GRACE_MS = Number(
  process.env.PROVIDER_STARTUP_GRACE_MS || 10_000,
);

async function bootstrap() {
  console.log(`[Provider] PID=${process.pid} starting`);
  /** Grace period for signals starts from this time; set to now when server is ready (after self-checks). */
  const readyTimeRef = { value: Date.now() };
  installRecoverableErrorGuards();

  const PORT = Number(process.env.PROVIDER_API_PORT || 8081);
  const host = '0.0.0.0';

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
      { path: 'health/runtime', method: RequestMethod.GET },
      { path: 'provider/runtime/ws', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ValidationPipe());

  // 👇 Читаем CORS_ORIGINS из env
  const origins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
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

  const bootstrapLogger = new Logger('Provider');
  const configService = app.get(ConfigService);
  const providerConfig = configService.getConfig()?.provider as
    | { allowAnonymousInDev?: boolean }
    | undefined;
  const allowAnonymousInDev =
    providerConfig?.allowAnonymousInDev === true ||
    process.env.PROVIDER_ALLOW_ANONYMOUS_IN_DEV === 'true';
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && allowAnonymousInDev) {
    bootstrapLogger.warn(
      '⚠️ Provider API allows anonymous requests in DEV mode',
    );
  }

  // 👇 Swagger
  const config = new DocumentBuilder()
    .setTitle('Barfinex Provider API')
    .setDescription(
      'Unified API for the Barfinex Provider: connectors, market data, candles, orders, detectors, inspectors, ' +
        'and proxy endpoints to Advisor/Detector/Inspector services. ' +
        '**Security:** All `/api/*` endpoints require a Provider API token (from `config.provider.apiToken`). ' +
        'Send as **Authorization: Bearer &lt;token&gt;** or **x-api-token** header. Health and metrics endpoints at ' +
        '`/health/*` and `/metrics` do not require authentication.',
    )
    .setVersion('1.0')
    .addTag('Connectors', 'Market data provider connectors and configuration')
    .addTag(
      'Detectors',
      'Detector CRUD, symbols, indicators, capital efficiency',
    )
    .addTag('Inspectors', 'Inspector CRUD and risk management')
    .addTag('Accounts', 'Account info and leverage')
    .addTag('Orders', 'Place, update, close, and list orders')
    .addTag('Candles', 'Historical OHLCV candles and candle integrity debug')
    .addTag('Symbols', 'Trading symbols by connector and market')
    .addTag('MarketData', 'Trades, orderbook, and market data from QuestDB')
    .addTag(
      'Runtime',
      'Provider instance identity, ownership, shards, ingestion metrics',
    )
    .addTag(
      'AdvisorProxy',
      'Proxy to Advisor service (analytics, telemetry, health)',
    )
    .addTag(
      'DetectorProxy',
      'Proxy to Detector service (health, risk, metrics)',
    )
    .addTag('InspectorProxy', 'Proxy to Inspector service')
    .addTag(
      'ProviderGateway',
      'Gateway: strategies, detector/inspector proxy, system health',
    )
    .addTag('AppRegistry', 'App registration, heartbeat, unregister')
    .addTag('Signals', 'Signal context for a symbol')
    .addTag('Dashboard', 'Operational dashboard overview')
    .addTag(
      'Proxy',
      'Generic proxy to advisors/inspectors/detectors by app key',
    )
    .addTag('Subscriptions', 'Subscribe to market events')
    .addTag('Assets', 'Available assets')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Token',
        name: 'Authorization',
        description:
          'Provider API token. Use: Authorization: Bearer <token> (same as config.provider.apiToken).',
        in: 'header',
      },
      'ProviderApiToken',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-api-token',
        in: 'header',
        description:
          'Alternative to Bearer: send Provider API token in x-api-token header.',
      },
      'x-api-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const SHUTDOWN_CLOSE_MS = Number(
    process.env.PROVIDER_SHUTDOWN_TIMEOUT_MS || 5000,
  );

  let shuttingDown = false;
  const closeApp = async (
    signal: NodeJS.Signals,
    options?: { reemitSignal?: boolean; exitCode?: number },
  ) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Provider] PID=${process.pid} shutting down`);
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[Provider bootstrap] Shutdown timeout after ${SHUTDOWN_CLOSE_MS}ms, exiting.`,
          );
          resolve();
        }, SHUTDOWN_CLOSE_MS);
      }),
    ]);
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
    // On Windows nodemon may use SIGUSR2; we don't re-emit, so exit explicitly for clean restart.
    if (signal === 'SIGUSR2') {
      process.exit(0);
    }
  };

  // Nodemon uses SIGUSR2 (Unix) or SIGINT (Windows) during restarts.
  // Accept SIGINT/SIGTERM so Nest runs graceful shutdown (onModuleDestroy, app.close()).
  process.once('SIGUSR2', () => {
    void closeApp('SIGUSR2', { reemitSignal: true }).catch((error) => {
      console.warn(
        `[Provider bootstrap] SIGUSR2 shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  const sigintHandler = async () => {
    const elapsed = Date.now() - readyTimeRef.value;
    const inGracePeriod = elapsed < PROVIDER_STARTUP_GRACE_MS;
    if (inGracePeriod) {
      console.warn(
        `[Provider bootstrap] SIGINT ignored (grace period): ${elapsed}ms < ${PROVIDER_STARTUP_GRACE_MS}ms`,
      );
      return;
    }
    process.removeListener('SIGINT', sigintHandler);
    try {
      await closeApp('SIGINT', { exitCode: 0 });
    } catch (error) {
      console.warn(
        `[Provider bootstrap] SIGINT shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  };
  process.on('SIGINT', sigintHandler);
  const sigtermHandler = async () => {
    const elapsed = Date.now() - readyTimeRef.value;
    const inGracePeriod = elapsed < PROVIDER_STARTUP_GRACE_MS;
    if (inGracePeriod) {
      console.warn(
        `[Provider bootstrap] SIGTERM ignored (grace period): ${elapsed}ms < ${PROVIDER_STARTUP_GRACE_MS}ms`,
      );
      return;
    }
    process.removeListener('SIGTERM', sigtermHandler);
    try {
      await closeApp('SIGTERM', { exitCode: 0 });
    } catch (error) {
      console.warn(
        `[Provider bootstrap] SIGTERM shutdown handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  };
  process.on('SIGTERM', sigtermHandler);

  // Nest runs onModuleInit/onApplicationBootstrap inside listen(). If Redis/QuestDB/Connector
  // init throws here, listen() rejects and no port is bound (ERR_CONNECTION_REFUSED from Studio).
  console.log(`[Provider bootstrap] Binding HTTP server to ${host}:${PORT}...`);
  await app.listen(PORT, host);
  console.log(`[Provider bootstrap] listen() resolved, running self-checks`);

  app.get(ProviderBootstrapService).markHttpStarted();

  const proto = httpsOptions ? 'https' : 'http';
  const baseUrl = `${proto}://localhost:${PORT}`;
  process.stderr.write(`[Provider bootstrap] 🚀 API listening on ${baseUrl}\n`);
  console.log(`[Provider bootstrap] 🚀 API listening on ${baseUrl}`);
  console.log(
    `   Health (no prefix): ${baseUrl}/health/live  and  ${baseUrl}/health/ready`,
  );
  console.log(`   API base: ${baseUrl}/api`);
  console.log(`   Swagger docs: ${baseUrl}/api/docs`);
  const wsScheme = httpsOptions ? 'wss' : 'ws';
  const wsEndpoint = `${wsScheme}://localhost:${PORT}/ws`;
  console.log(
    `   [Provider WS] WebSocket endpoint available at: ${wsEndpoint}`,
  );
  console.log(`   WebSocket (Socket.IO): ${baseUrl}/ws`);

  // Verify server is reachable (helps diagnose ECONNREFUSED when MCP/Studio cannot connect).
  try {
    const http = await import('http');
    const https = await import('https');
    const healthUrl = `${baseUrl}/health/live`;
    const client = proto === 'https' ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = client.get(
        healthUrl,
        { rejectUnauthorized: false },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            console.log(
              `[Provider bootstrap] Self-check OK: ${healthUrl} -> ${res.statusCode}`,
            );
          } else {
            console.warn(
              `[Provider bootstrap] Self-check unexpected: ${healthUrl} -> ${res.statusCode}`,
            );
          }
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('Self-check timeout'));
      });
    });
  } catch (e: any) {
    console.warn(
      `[Provider bootstrap] Self-check failed (server may still be usable): ${
        e?.message || e
      }`,
    );
  }

  // Optional: verify WebSocket endpoint info route is reachable.
  try {
    const wsInfoUrl = `${baseUrl}/provider/runtime/ws`;
    const http = await import('http');
    const https = await import('https');
    const client = proto === 'https' ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = client.get(
        wsInfoUrl,
        { rejectUnauthorized: false },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(body);
                if (data?.websocket === 'available' && data?.endpoint) {
                  console.log(
                    `[Provider bootstrap] WS endpoint self-check OK: ${data.endpoint}`,
                  );
                }
              } catch {
                // ignore parse
              }
            } else {
              console.warn(
                `[Provider bootstrap] WS endpoint self-check unexpected: ${wsInfoUrl} -> ${res.statusCode}`,
              );
            }
            resolve();
          });
          res.resume();
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('WS self-check timeout'));
      });
    });
  } catch (e: any) {
    console.warn(
      `[Provider bootstrap] WS endpoint self-check failed (WS may still work): ${
        e?.message || e
      }`,
    );
  }

  console.log(`[Provider bootstrap] self-checks done, setting readyTimeRef`);
  readyTimeRef.value = Date.now();
}
const globalWithBootstrapGuard = globalThis as typeof globalThis & {
  [PROVIDER_BOOTSTRAP_GUARD]?: boolean;
};
let bootstrapRetryAttempt = 0;
let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;

function isEaddrInUseError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    msg.includes('eaddrinuse') ||
    (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
  );
}

/** Treat infrastructure connection errors as retriable. EADDRINUSE is retried separately (see EADDRINUSE_RETRY_*). */
function isRetriableBootstrapError(error: unknown): boolean {
  if (isEaddrInUseError(error)) return false;
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
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
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  bootstrapRetryAttempt += 1;

  const isPortInUse = isEaddrInUseError(error);
  if (isPortInUse && bootstrapRetryAttempt <= EADDRINUSE_RETRY_ATTEMPTS) {
    console.warn(
      `[Provider bootstrap] Port in use (EADDRINUSE), attempt ${bootstrapRetryAttempt}/${EADDRINUSE_RETRY_ATTEMPTS}. Retrying in ${EADDRINUSE_RETRY_DELAY_MS}ms (previous process may still be closing).`,
    );
    if (bootstrapRetryTimer) return;
    bootstrapRetryTimer = setTimeout(() => {
      bootstrapRetryTimer = null;
      void bootstrap()
        .then(() => {
          bootstrapRetryAttempt = 0;
        })
        .catch(scheduleBootstrapRetry);
    }, EADDRINUSE_RETRY_DELAY_MS);
    return;
  }

  if (isPortInUse) {
    console.error(
      `[Provider bootstrap] Port still in use after ${EADDRINUSE_RETRY_ATTEMPTS} attempts. Exiting.`,
    );
    process.exit(1);
    return;
  }

  const retriable = isRetriableBootstrapError(error);
  const delayMs = Math.min(
    PROVIDER_BOOTSTRAP_RETRY_BASE_MS *
      Math.pow(2, Math.min(bootstrapRetryAttempt, 8)),
    PROVIDER_BOOTSTRAP_RETRY_MAX_MS,
  );

  console.error(
    `[Provider bootstrap] Fatal startup error (attempt=${bootstrapRetryAttempt}): ${message}`,
  );
  if (!retriable) {
    console.error(
      '[Provider bootstrap] Non-retriable error. Exiting; nodemon will restart if applicable.',
    );
    process.exit(1);
    return;
  }
  console.warn(
    '[Provider bootstrap] Infrastructure connection error (QuestDB/Redis/Connector). Server did not bind to port — app.listen() failed during module init. Retrying until services are up.',
  );
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
