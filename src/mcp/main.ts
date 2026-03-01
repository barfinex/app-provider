import * as dotenv from 'dotenv';
import axios from 'axios';
import { Agent as HttpsAgent } from 'https';
import { resolve } from 'path';

// Load env before importing provider-mcp because it reads env at module init.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

if (!process.env.PROVIDER_API_URL) {
  const port = process.env.PROVIDER_API_PORT || '8080';
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

function isOpenApiReady(status: number, data: unknown): boolean {
  return (
    status >= 200 &&
    status < 300 &&
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { paths?: unknown }).paths === 'object'
  );
}

async function waitForProviderOpenApiReady(): Promise<void> {
  const apiUrl = process.env.PROVIDER_API_URL!;
  const parsed = new URL(apiUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const probes = [`${origin}/docs-json`, `${apiUrl.replace(/\/+$/, '')}/docs-json`];
  const allowInsecureTls = process.env.PROVIDER_MCP_INSECURE_TLS === 'true';
  const httpsAgent = allowInsecureTls
    ? new HttpsAgent({ rejectUnauthorized: false })
    : undefined;
  const startedAt = Date.now();

  process.stderr.write('[provider-mcp] Waiting for Provider OpenAPI readiness...\n');

  while (Date.now() - startedAt < PROVIDER_READY_TIMEOUT_MS) {
    for (const probeUrl of probes) {
      try {
        const response = await axios.get(probeUrl, {
          timeout: 2500,
          validateStatus: () => true,
          httpsAgent,
        });
        if (isOpenApiReady(response.status, response.data)) {
          process.stderr.write(
            `[provider-mcp] Provider OpenAPI ready at ${probeUrl} (status=${response.status}).\n`,
          );
          return;
        }
      } catch {
        // keep polling
      }
    }

    await new Promise(resolveSleep => setTimeout(resolveSleep, PROVIDER_READY_POLL_MS));
  }

  throw new Error(
    `Provider OpenAPI readiness timeout after ${PROVIDER_READY_TIMEOUT_MS}ms (${probes.join(', ')})`,
  );
}

async function bootstrapMcp(): Promise<void> {
  await waitForProviderOpenApiReady();
  const { startProviderMcpServer } = await import('@barfinex/provider-mcp');
  await startProviderMcpServer();
}

bootstrapMcp().catch(error => {
  process.stderr.write(
    `[provider-mcp] startup failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
