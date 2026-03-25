import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AxiosRequestConfig } from 'axios';
import { lastValueFrom } from 'rxjs';

export interface DetectorProxyResult {
  status: number;
  data: unknown;
}

interface DetectorProxyErrorResponse {
  error: string;
  status: number;
  timestamp: number;
}

@Injectable()
export class DetectorProxyService {
  private readonly logger = new Logger(DetectorProxyService.name);
  private readonly timeoutMs = this.resolveTimeoutMs();
  private readonly allowedMethods = new Set([
    'GET',
    'POST',
    'DELETE',
    'PUT',
    'PATCH',
  ]);
  private readonly forwardTraceHeaders = ['x-request-id', 'x-correlation-id'];

  constructor(private readonly httpService: HttpService) {}

  async get(
    endpoint: string,
    query?: Record<string, unknown>,
    headers?: Record<string, unknown>,
  ): Promise<DetectorProxyResult> {
    return this.request('GET', endpoint, query, undefined, headers);
  }

  async request(
    method: string,
    endpoint: string,
    query?: Record<string, unknown>,
    body?: Record<string, unknown>,
    headers?: Record<string, unknown>,
  ): Promise<DetectorProxyResult> {
    const normalizedMethod = method.toUpperCase();
    if (!this.allowedMethods.has(normalizedMethod)) {
      throw this.createNormalizedError(
        HttpStatus.METHOD_NOT_ALLOWED,
        `Method ${normalizedMethod} not allowed`,
      );
    }

    const url = this.buildDetectorUrl(endpoint);
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
        `[DETECTOR_PROXY] endpoint=${endpoint} status=${response.status}`,
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

      return {
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[DETECTOR_PROXY] endpoint=${endpoint} unavailable: ${message}`,
      );
      throw this.createNormalizedError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Detector API temporarily unavailable',
      );
    }
  }

  private buildDetectorUrl(endpoint: string): string {
    const baseUrl = (
      process.env.DETECTOR_API_URL || 'http://localhost:8101/api'
    )
      .trim()
      .replace(/\/+$/, '');
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    if (
      cleanEndpoint.startsWith('detector/') ||
      cleanEndpoint.startsWith('risk/') ||
      cleanEndpoint === 'metrics' ||
      cleanEndpoint.startsWith('metrics/')
    ) {
      return `${baseUrl}/${cleanEndpoint}`;
    }
    return `${baseUrl}/detector/${cleanEndpoint}`;
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
        ? value.map((item) => String(item)).join(', ')
        : String(value);
    }
    return headers;
  }

  private createNormalizedError(status: number, error: string): HttpException {
    return new HttpException(this.createErrorPayload(status, error), status);
  }

  private resolveTimeoutMs(): number {
    const fallbackTimeoutMs = 10000;
    const parsed = Number(process.env.DETECTOR_PROXY_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackTimeoutMs;
    return parsed;
  }

  private createErrorPayload(
    status: number,
    error: string,
  ): DetectorProxyErrorResponse {
    return {
      error,
      status,
      timestamp: Date.now(),
    };
  }

  private extractErrorMessage(input: unknown): string {
    if (typeof input === 'string' && input.trim().length > 0) return input;
    if (typeof input !== 'object' || input === null)
      return 'Detector request failed';

    const asRecord = input as Record<string, unknown>;
    const candidate = asRecord.error ?? asRecord.message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
    return 'Detector request failed';
  }
}
