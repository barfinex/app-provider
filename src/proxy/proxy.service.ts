import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { AxiosRequestConfig } from 'axios';
import {
  AppStatus,
  ProxyAppType,
  ProxyForwardResult,
  ProxyTarget,
} from './proxy.types';
import { AppRegistryService } from '../app-registry/app-registry.service';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly appRegistryService: AppRegistryService,
  ) {}

  async getTargetsByType(type: ProxyAppType): Promise<ProxyTarget[]> {
    const rows = await this.appRegistryService.list({
      appType: type,
      includeInactive: true,
    });
    return rows.map((r) => ({
      key: r.appKey,
      type: r.appType,
      baseUrl: r.baseUrl,
      enabled: r.isActive,
      status: (r.status === 'unregistered'
        ? 'unregistered'
        : r.isActive
        ? 'active'
        : 'offline') as ProxyTarget['status'],
      source: 'db',
    }));
  }

  async forward(params: {
    type: ProxyAppType;
    appKey: string;
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, unknown>;
  }): Promise<ProxyForwardResult> {
    const target = await this.resolveTarget(params.type, params.appKey);
    const url = this.buildUrl(target.baseUrl, params.path, params.query);
    const method = params.method.toUpperCase();

    const axiosConfig: AxiosRequestConfig = {
      url,
      method: method as AxiosRequestConfig['method'],
      data: params.body,
      headers: this.buildForwardHeaders(params.headers),
      validateStatus: () => true,
      timeout: Number(process.env.PROVIDER_PROXY_TIMEOUT_MS || 15000),
    };

    const response = await lastValueFrom(this.httpService.request(axiosConfig));
    if (response.status >= 500) {
      this.logger.warn(
        `Upstream error: ${method} ${url} → HTTP ${response.status}`,
      );
    }
    return {
      status: response.status,
      data: response.data,
      headers: this.pickResponseHeaders(
        response.headers as Record<string, unknown>,
      ),
    };
  }

  private async resolveTarget(
    type: ProxyAppType,
    key: string,
  ): Promise<ProxyTarget> {
    const normalizedKey = key.trim();
    const resolved = await this.appRegistryService.resolveActiveTarget(
      type,
      normalizedKey,
    );
    return {
      key: resolved.appKey,
      type: resolved.appType,
      baseUrl: resolved.baseUrl,
      enabled: true,
      status: 'active' as AppStatus,
      source: 'db',
    };
  }

  private buildUrl(
    baseUrl: string,
    path: string,
    query?: Record<string, unknown>,
  ): string {
    const cleanPath = path.replace(/^\/+/, '');
    const url = cleanPath ? `${baseUrl}/${cleanPath}` : baseUrl;
    if (!query || Object.keys(query).length === 0) return url;

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          params.append(k, String(item));
        }
      } else {
        params.append(k, String(v));
      }
    }
    const queryString = params.toString();
    return queryString ? `${url}?${queryString}` : url;
  }

  private buildForwardHeaders(
    input?: Record<string, unknown>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!input) return headers;

    for (const [key, value] of Object.entries(input)) {
      const lower = key.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'connection'
      ) {
        continue;
      }
      if (value === undefined || value === null) continue;
      headers[key] = Array.isArray(value)
        ? value.map((v) => String(v)).join(', ')
        : String(value);
    }
    return headers;
  }

  private pickResponseHeaders(
    input: Record<string, unknown> | undefined,
  ): Record<string, string | string[] | undefined> {
    if (!input) return {};
    const out: Record<string, string | string[] | undefined> = {};
    const forwardList = ['content-type', 'cache-control', 'etag'];
    for (const name of forwardList) {
      const value = input[name];
      if (typeof value === 'string' || Array.isArray(value)) {
        out[name] = value as string | string[];
      }
    }
    return out;
  }
}
