import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { applyProviderWsAdapter } from '@barfinex/provider-ws-bridge';

import * as dotenv from 'dotenv';
import { resolve } from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const PROVIDER_BOOTSTRAP_GUARD = '__BARFINEX_PROVIDER_BOOTSTRAP_STARTED__';

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

// 👇 Сначала база .env, затем .env.{APP_MODE} (переменные из второго перезаписывают)
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

async function bootstrap() {
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

  const app = await NestFactory.create(AppModule, { httpsOptions });
  app.enableShutdownHooks();

  app.setGlobalPrefix('api');
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
    options?: { reemitSignal?: boolean },
  ) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      // no-op: process is shutting down anyway
    } finally {
      if (options?.reemitSignal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(0);
      }
    }
  };

  // Nodemon uses SIGUSR2 during restarts; close HTTP server first to avoid EADDRINUSE.
  process.once('SIGUSR2', () => {
    void closeApp('SIGUSR2', { reemitSignal: true });
  });
  process.once('SIGINT', () => {
    void closeApp('SIGINT');
  });
  process.once('SIGTERM', () => {
    void closeApp('SIGTERM');
  });

  const PORT = Number(process.env.PROVIDER_API_PORT || 8080);
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    await ensurePortFreeDev(PORT);
  }

  try {
    await app.listen(PORT, '0.0.0.0');
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} is already in use. Either:`);
      console.error(
        `   • Stop the other process using port ${PORT} (e.g. close the other terminal with the provider)`,
      );
      process.exit(1);
    }
    throw err;
  }

  const proto = httpsOptions ? 'https' : 'http';
  console.log(`🚀 Provider API is running on: ${proto}://localhost:${PORT}/api`);
  console.log(`📑 Documentation: ${proto}://localhost:${PORT}/docs`);
  console.log(`🔌 WebSocket (Socket.IO) at: ${proto}://localhost:${PORT}/ws`);
}
const globalWithBootstrapGuard = globalThis as typeof globalThis & {
  [PROVIDER_BOOTSTRAP_GUARD]?: boolean;
};

if (!globalWithBootstrapGuard[PROVIDER_BOOTSTRAP_GUARD]) {
  globalWithBootstrapGuard[PROVIDER_BOOTSTRAP_GUARD] = true;
  void bootstrap();
} else {
  console.warn('Provider bootstrap skipped: already started in this process.');
}
