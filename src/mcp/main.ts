import * as dotenv from 'dotenv';
import axios from 'axios';
import { Agent as HttpsAgent } from 'https';
import { resolve } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';

// Load env before importing provider-mcp because it reads env at module init.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

if (!process.env.PROVIDER_API_URL) {
  const port = process.env.PROVIDER_API_PORT || '8081';
  const hasHttpsCerts = Boolean(process.env.SSL_KEY && process.env.SSL_CERT);
  const protocol = hasHttpsCerts ? 'https' : 'http';
  process.env.PROVIDER_API_URL = `${protocol}://localhost:${port}/api`;
}

if (
  process.env.PROVIDER_MCP_INSECURE_TLS == null &&
  process.env.PROVIDER_API_URL.startsWith('https://')
) {
  // Dev setup often uses self-signed certs.
  process.env.PROVIDER_MCP_INSECURE_TLS = 'true';
}

const PROVIDER_READY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.PROVIDER_MCP_PROVIDER_READY_TIMEOUT_MS || 180000),
);
const PROVIDER_READY_POLL_MS = Math.max(
  250,
  Number(process.env.PROVIDER_MCP_PROVIDER_READY_POLL_MS || 1000),
);
const MCP_RESTART_BASE_MS = Math.max(
  1_000,
  Number(process.env.PROVIDER_MCP_RESTART_BASE_MS || 2_000),
);
const MCP_RESTART_MAX_MS = Math.max(
  MCP_RESTART_BASE_MS,
  Number(process.env.PROVIDER_MCP_RESTART_MAX_MS || 30_000),
);
const MCP_MAX_STARTUP_FAILURES_BEFORE_COOLDOWN = Math.max(
  1,
  Number(process.env.PROVIDER_MCP_MAX_STARTUP_FAILURES_BEFORE_COOLDOWN || 5),
);
const MCP_METRICS_LOG_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.PROVIDER_MCP_SUPERVISOR_METRICS_LOG_INTERVAL_MS || 30_000),
);
const MCP_SUPERVISOR_STATUS_FILE =
  process.env.PROVIDER_MCP_SUPERVISOR_STATUS_FILE
  || resolve(process.cwd(), '.runtime/provider-mcp-supervisor.json');

let mcpStopping = false;
let supervisorStarted = false;
let shutdownPromise: Promise<void> | null = null;
let shutdownResolve: (() => void) | null = null;
type SupervisorState = 'starting' | 'running' | 'restarting' | 'cooldown' | 'stopping';
const supervisorMetrics: {
  state: SupervisorState;
  restartAttempts: number;
  lastSuccessfulStartupAt: string | null;
  lastFailureAt: string | null;
} = {
  state: 'starting',
  restartAttempts: 0,
  lastSuccessfulStartupAt: null,
  lastFailureAt: null,
};
let metricsInterval: NodeJS.Timeout | null = null;

function isOpenApiReady(status: number, data: unknown): boolean {
  return (
    status >= 200 &&
    status < 300 &&
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { paths?: unknown }).paths === 'object'
  );
}

function buildOpenApiProbeUrls(apiUrl: string): string[] {
  const parsed = new URL(apiUrl);
  const hostnames = new Set<string>([parsed.hostname]);
  if (parsed.hostname === 'localhost') {
    hostnames.add('127.0.0.1');
  } else if (parsed.hostname === '127.0.0.1') {
    hostnames.add('localhost');
  }

  const urls = new Set<string>();
  for (const hostname of hostnames) {
    const rootUrl = new URL(parsed.toString());
    rootUrl.hostname = hostname;

    const apiBase = `${rootUrl.protocol}//${rootUrl.host}${rootUrl.pathname.replace(/\/+$/, '')}`;
    const origin = `${rootUrl.protocol}//${rootUrl.host}`;
    urls.add(`${origin}/docs-json`);
    urls.add(`${apiBase}/docs-json`);
  }

  return Array.from(urls);
}

async function waitForProviderOpenApiReady(): Promise<void> {
  const apiUrl = process.env.PROVIDER_API_URL!;
  const probes = buildOpenApiProbeUrls(apiUrl);
  const allowInsecureTls = process.env.PROVIDER_MCP_INSECURE_TLS === 'true';
  const httpsAgent = allowInsecureTls
    ? new HttpsAgent({ rejectUnauthorized: false })
    : undefined;
  const bearerToken =
    (process.env.PROVIDER_BEARER_TOKEN || process.env.PROVIDER_API_TOKEN || '').trim();
  const probeHeaders = bearerToken
    ? {
        Authorization: `Bearer ${bearerToken}`,
        'x-api-token': bearerToken,
      }
    : undefined;
  const startedAt = Date.now();
  let lastProbeError = 'none';

  process.stderr.write('[provider-mcp] Waiting for Provider OpenAPI readiness...\n');

  while (Date.now() - startedAt < PROVIDER_READY_TIMEOUT_MS) {
    for (const probeUrl of probes) {
      try {
        const response = await axios.get(probeUrl, {
          timeout: 2500,
          validateStatus: () => true,
          httpsAgent,
          headers: probeHeaders,
        });
        if (isOpenApiReady(response.status, response.data)) {
          process.stderr.write(
            `[provider-mcp] Provider OpenAPI ready at ${probeUrl} (status=${response.status}).\n`,
          );
          return;
        }
        lastProbeError = `url=${probeUrl} status=${response.status}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastProbeError = `url=${probeUrl} request failed: ${msg}`;
      }
    }

    await new Promise(resolveSleep => setTimeout(resolveSleep, PROVIDER_READY_POLL_MS));
  }

  throw new Error(
    `Provider OpenAPI readiness timeout after ${PROVIDER_READY_TIMEOUT_MS}ms (${probes.join(', ')}) | last_probe=${lastProbeError}`,
  );
}

async function bootstrapMcp(): Promise<void> {
  if (String(process.env.BARFINEX_DISABLE_SUBSCRIPTION_LIBS || '').toLowerCase() === 'true') {
    process.stderr.write('[provider-mcp] disabled by BARFINEX_DISABLE_SUBSCRIPTION_LIBS=true\n');
    return;
  }
  await waitForProviderOpenApiReady();
  let startProviderMcpServer: (() => Promise<void>) | undefined;
  try {
    ({ startProviderMcpServer } = await import('@barfinex/provider-mcp'));
  } catch (error) {
    process.stderr.write(
      `[provider-mcp] optional package "@barfinex/provider-mcp" is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  if (!startProviderMcpServer) {
    process.stderr.write(
      '[provider-mcp] optional package "@barfinex/provider-mcp" did not export startProviderMcpServer\n',
    );
    return;
  }
  await startProviderMcpServer();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function markSupervisorState(state: SupervisorState): void {
  supervisorMetrics.state = state;
  void persistSupervisorMetrics();
}

function printSupervisorMetrics(reason: string): void {
  void persistSupervisorMetrics();
  process.stderr.write(
    `[provider-mcp] supervisor-metrics reason=${reason} state=${supervisorMetrics.state} restartAttempts=${supervisorMetrics.restartAttempts} lastSuccessfulStartupAt=${supervisorMetrics.lastSuccessfulStartupAt ?? 'n/a'} lastFailureAt=${supervisorMetrics.lastFailureAt ?? 'n/a'}\n`,
  );
}

async function persistSupervisorMetrics(): Promise<void> {
  try {
    const payload = {
      ...supervisorMetrics,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(MCP_SUPERVISOR_STATUS_FILE), { recursive: true });
    await writeFile(MCP_SUPERVISOR_STATUS_FILE, JSON.stringify(payload), 'utf8');
  } catch (error) {
    process.stderr.write(
      `[provider-mcp] failed to persist supervisor status: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function startMetricsLoop(): void {
  if (metricsInterval) return;
  metricsInterval = setInterval(() => {
    printSupervisorMetrics('interval');
  }, MCP_METRICS_LOG_INTERVAL_MS);
}

function stopMetricsLoop(): void {
  if (!metricsInterval) return;
  clearInterval(metricsInterval);
  metricsInterval = null;
}

function installMcpSignalHandlers(): void {
  const requestShutdown = (signal: NodeJS.Signals) => {
    if (mcpStopping) return;
    mcpStopping = true;
    markSupervisorState('stopping');
    printSupervisorMetrics(`signal-${signal}`);
    stopMetricsLoop();
    process.stderr.write(`[provider-mcp] shutdown requested via ${signal}\n`);
    shutdownResolve?.();
  };
  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
}

function getShutdownPromise(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = new Promise<void>(resolveShutdown => {
    shutdownResolve = resolveShutdown;
  });
  return shutdownPromise;
}

async function runMcpSupervisor(): Promise<void> {
  if (supervisorStarted) return;
  supervisorStarted = true;
  markSupervisorState('starting');
  startMetricsLoop();
  printSupervisorMetrics('startup');
  installMcpSignalHandlers();

  let consecutiveStartupFailures = 0;
  let restartAttempt = 0;

  while (!mcpStopping) {
    try {
      markSupervisorState(restartAttempt === 0 ? 'starting' : 'restarting');
      await bootstrapMcp();
      if (mcpStopping) break;
      consecutiveStartupFailures = 0;
      markSupervisorState('running');
      supervisorMetrics.lastSuccessfulStartupAt = new Date().toISOString();
      printSupervisorMetrics('bootstrap-ok');
      await getShutdownPromise();
      break;
    } catch (error) {
      consecutiveStartupFailures += 1;
      restartAttempt += 1;
      supervisorMetrics.restartAttempts = restartAttempt;
      supervisorMetrics.lastFailureAt = new Date().toISOString();
      markSupervisorState('restarting');
      const delayMs = Math.min(MCP_RESTART_BASE_MS * Math.pow(2, restartAttempt - 1), MCP_RESTART_MAX_MS);
      process.stderr.write(
        `[provider-mcp] startup failed attempt=${restartAttempt} consecutiveFailures=${consecutiveStartupFailures} delayMs=${delayMs} error=${formatError(
          error,
        )}\n`,
      );
      printSupervisorMetrics('startup-failed');

      // Avoid tight restart loops on persistent config/auth issues.
      if (consecutiveStartupFailures >= MCP_MAX_STARTUP_FAILURES_BEFORE_COOLDOWN) {
        const cooldownMs = Math.min(MCP_RESTART_MAX_MS, Math.max(delayMs, 10_000));
        markSupervisorState('cooldown');
        process.stderr.write(
          `[provider-mcp] entering cooldown after ${consecutiveStartupFailures} startup failures; cooldownMs=${cooldownMs}\n`,
        );
        printSupervisorMetrics('cooldown');
        await sleep(cooldownMs);
      } else {
        await sleep(delayMs);
      }
    }
  }
  markSupervisorState('stopping');
  printSupervisorMetrics('loop-end');
  stopMetricsLoop();
}

void runMcpSupervisor().catch(error => {
  markSupervisorState('stopping');
  supervisorMetrics.lastFailureAt = new Date().toISOString();
  printSupervisorMetrics('fatal-supervisor-error');
  stopMetricsLoop();
  process.stderr.write(`[provider-mcp] fatal supervisor error: ${formatError(error)}\n`);
});
