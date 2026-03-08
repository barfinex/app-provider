import { HttpService } from '@nestjs/axios';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AxiosRequestConfig } from 'axios';
import { Counter, register } from 'prom-client';
import { lastValueFrom } from 'rxjs';

export interface AdvisorProxyResult {
  status: number;
  data: unknown;
}

interface AdvisorProxyErrorResponse {
  error: string;
  status: number;
  timestamp: number;
}

interface CachedAdvisorProxyResult {
  value: AdvisorProxyResult;
  expiresAt: number;
}

@Injectable()
export class AdvisorProxyService {
  private readonly logger = new Logger(AdvisorProxyService.name);
  private readonly timeoutMs = this.resolveTimeoutMs();
  private readonly cache = new Map<string, CachedAdvisorProxyResult>();
  private readonly allowedMethods = new Set(['GET', 'POST']);
  private readonly forwardTraceHeaders = ['x-request-id', 'x-correlation-id'];
  private readonly cacheTtlMsByEndpoint: Record<string, number> = {
    'analytics/summary': 2000,
    'conviction/last': 1000,
    'market-state/health': 1000,
    'decision/cache': 5000,
    'analytics/recent': 2000,
  };
  private readonly cacheHitCounter: Counter<string>;
  private readonly cacheMissCounter: Counter<string>;

  constructor(private readonly httpService: HttpService) {
    this.cacheHitCounter = this.getOrCreateCounter(
      'advisor_proxy_cache_hit_total',
      'Advisor proxy cache hit count',
      ['endpoint'],
    );
    this.cacheMissCounter = this.getOrCreateCounter(
      'advisor_proxy_cache_miss_total',
      'Advisor proxy cache miss count',
      ['endpoint'],
    );
  }

  async get(
    endpoint: string,
    query?: Record<string, unknown>,
    headers?: Record<string, unknown>,
  ): Promise<AdvisorProxyResult> {
    return this.request('GET', endpoint, query, undefined, headers);
  }

  async post(
    endpoint: string,
    body?: Record<string, unknown>,
    query?: Record<string, unknown>,
    headers?: Record<string, unknown>,
  ): Promise<AdvisorProxyResult> {
    return this.request('POST', endpoint, query, body, headers);
  }

  async request(
    method: string,
    endpoint: string,
    query?: Record<string, unknown>,
    body?: Record<string, unknown>,
    headers?: Record<string, unknown>,
  ): Promise<AdvisorProxyResult> {
    const normalizedMethod = method.toUpperCase();
    if (!this.allowedMethods.has(normalizedMethod)) {
      throw this.createNormalizedError(
        HttpStatus.METHOD_NOT_ALLOWED,
        `Method ${normalizedMethod} not allowed`,
      );
    }

    const ttlMs = this.cacheTtlMsByEndpoint[endpoint];
    const allowCache = normalizedMethod === 'GET' && Boolean(ttlMs);
    if (allowCache) {
      const cacheKey = this.buildCacheKey(endpoint, query ?? {});
      const cached = this.getCached(cacheKey);
      if (cached) {
        this.logCacheResult(endpoint, true);
        this.cacheHitCounter.labels(endpoint).inc();
        return cached;
      }
      this.logCacheResult(endpoint, false);
      this.cacheMissCounter.labels(endpoint).inc();
    }

    const url = this.buildAdvisorUrl(endpoint);
    const config: AxiosRequestConfig = {
      url,
      method: normalizedMethod as AxiosRequestConfig['method'],
      params: query ?? {},
      data: body,
      timeout: this.timeoutMs,
      headers: this.buildTraceHeaders(headers),
      validateStatus: () => true,
    };

    try {
      const response = await lastValueFrom(this.httpService.request(config));
      this.logger.debug(
        `[ADVISOR_PROXY] endpoint=${endpoint} status=${response.status}`,
      );
      if (response.status >= 400) {
        return {
          status: response.status,
          data: this.createErrorPayload(
            response.status,
            this.extractErrorMessage(response.data),
          ),
        };
      }

      const result: AdvisorProxyResult = {
        status: response.status,
        data: response.data,
      };

      if (allowCache && ttlMs) {
        const cacheKey = this.buildCacheKey(endpoint, query ?? {});
        this.cache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + ttlMs,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[ADVISOR_PROXY] endpoint=${endpoint} unavailable: ${message}`,
      );
      throw this.createNormalizedError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Advisor API temporarily unavailable',
      );
    }
  }

  private buildAdvisorUrl(endpoint: string): string {
    const baseUrl = (process.env.ADVISOR_API_URL || 'http://localhost:8009/api')
      .trim()
      .replace(/\/+$/, '');
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    return `${baseUrl}/advisor/${cleanEndpoint}`;
  }

  private buildCacheKey(endpoint: string, query: Record<string, unknown>): string {
    return `${endpoint}:${JSON.stringify(query)}`;
  }

  private getCached(cacheKey: string): AdvisorProxyResult | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }
    return entry.value;
  }

  private logCacheResult(endpoint: string, hit: boolean): void {
    this.logger.debug(`[ADVISOR_PROXY_CACHE] endpoint=${endpoint} hit=${hit}`);
  }

  private getOrCreateCounter(
    name: string,
    help: string,
    labelNames: string[],
  ): Counter<string> {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Counter<string>;
    return new Counter({
      name,
      help,
      labelNames,
    });
  }

  private buildTraceHeaders(
    input?: Record<string, unknown>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!input) return headers;

    for (const name of this.forwardTraceHeaders) {
      const value = input[name];
      if (value === undefined || value === null) continue;
      headers[name] = Array.isArray(value)
        ? value.map(item => String(item)).join(', ')
        : String(value);
    }
    return headers;
  }

  private createNormalizedError(status: number, error: string): HttpException {
    return new HttpException(this.createErrorPayload(status, error), status);
  }

  private resolveTimeoutMs(): number {
    const fallbackTimeoutMs = 10000;
    const parsed = Number(process.env.ADVISOR_PROXY_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackTimeoutMs;
    return parsed;
  }

  private createErrorPayload(
    status: number,
    error: string,
  ): AdvisorProxyErrorResponse {
    return {
      error,
      status,
      timestamp: Date.now(),
    };
  }

  private extractErrorMessage(input: unknown): string {
    if (typeof input === 'string' && input.trim().length > 0) return input;
    if (typeof input !== 'object' || input === null) return 'Advisor request failed';

    const asRecord = input as Record<string, unknown>;
    const candidate = asRecord.error ?? asRecord.message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
    return 'Advisor request failed';
  }
}
