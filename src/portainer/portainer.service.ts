import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { decode } from 'jsonwebtoken';
import { PortainerContainer } from './portainer.interface';

@Injectable()
export class PortainerService {
  private readonly logger = new Logger(PortainerService.name);
  private readonly host =
    process.env.PORTAINER_HOST || process.env.PONTEINER_HOST || '';
  private readonly port =
    process.env.PORTAINER_PORT || process.env.PONTEINER_PORT || '';
  private readonly baseUrl = `http://${this.host}:${this.port}/api`;
  private token: string | null = null;

  private readonly username =
    process.env.PORTAINER_ADMIN_USERNAME ||
    process.env.PONTEINER_ADMIN_USERNAME;
  private readonly password =
    process.env.PORTAINER_ADMIN_PASSWORD ||
    process.env.PONTEINER_ADMIN_PASSWORD;
  private readonly requestTimeoutMs = Number(
    process.env.PORTAINER_TIMEOUT_MS || 5000,
  );
  private readonly authCooldownMs = Number(
    process.env.PORTAINER_AUTH_RETRY_COOLDOWN_MS || 30000,
  );

  private authInFlight: Promise<void> | null = null;
  private authBackoffUntil = 0;
  private missingConfigLogged = false;

  /**
   * Проверка, истек ли токен
   */
  isTokenExpired(token: string): boolean {
    try {
      const decoded = decode(token) as { exp?: number } | null;
      if (!decoded?.exp) return true;

      const currentTime = Math.floor(Date.now() / 1000);
      return decoded.exp < currentTime;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to decode token: ${err.message}`);
      return true;
    }
  }

  /**
   * Аутентификация с Portainer API
   */
  private async authenticate(): Promise<void> {
    if (!this.isConfigured()) {
      const msg =
        'Portainer integration is not configured (host/port/credentials missing)';
      if (!this.missingConfigLogged) {
        this.logger.warn(msg);
        this.missingConfigLogged = true;
      }
      throw new ServiceUnavailableException(msg);
    }

    try {
      const response = await axios.post<{ jwt: string }>(
        `${this.baseUrl}/auth`,
        {
          Username: this.username,
          Password: this.password,
        },
        {
          timeout: this.requestTimeoutMs,
        },
      );

      if (response.data?.jwt) {
        this.token = response.data.jwt;
        this.logger.log('Authentication successful.');
      } else {
        throw new HttpException(
          'Failed to authenticate with Portainer',
          HttpStatus.UNAUTHORIZED,
        );
      }
    } catch (error: unknown) {
      const err = error as AxiosError<{ message?: string }>;
      const message =
        err.response?.data?.message || err.message || 'Authentication error';
      this.logger.error(`Authentication error: ${message}`);
      this.authBackoffUntil = Date.now() + this.authCooldownMs;
      throw new HttpException(message, HttpStatus.UNAUTHORIZED);
    }
  }

  /**
   * Проверка и обновление токена
   */
  private async ensureAuthenticated(): Promise<void> {
    const now = Date.now();
    if (this.authBackoffUntil > now) {
      const waitMs = this.authBackoffUntil - now;
      throw new ServiceUnavailableException(
        `Portainer authentication is in cooldown. Retry in ${waitMs} ms.`,
      );
    }

    if (!this.token || this.isTokenExpired(this.token)) {
      this.logger.warn('Token is missing or expired. Authenticating...');
      if (!this.authInFlight) {
        this.authInFlight = this.authenticate().finally(() => {
          this.authInFlight = null;
        });
      }
      await this.authInFlight;
    }
  }

  /**
   * Универсальный запрос к Portainer API с типобезопасной обработкой ошибок
   */
  async fetchPortainerResource<T>(
    url: string,
    resourceName: string,
  ): Promise<T> {
    await this.ensureAuthenticated();

    try {
      const response = await axios.get<T>(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: this.requestTimeoutMs,
      });
      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosError<{ message?: string }>;
      if (err.response?.status === 401) {
        this.token = null;
      }
      const message =
        err.response?.data?.message ||
        err.message ||
        `Failed to fetch ${resourceName}`;
      const status = err.response?.status || HttpStatus.BAD_REQUEST;

      this.logger.error(`Error fetching ${resourceName}: ${message}`);
      throw new HttpException(message, status);
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.host && this.port && this.username && this.password);
  }

  /**
   * Получение всех контейнеров Portainer
   */
  async getContainers(): Promise<PortainerContainer[]> {
    const endpointName = 'local';
    try {
      const endpoints = await this.fetchPortainerResource<any[]>(
        `${this.baseUrl}/endpoints`,
        'endpoints',
      );

      const targetEndpoint = endpoints.find(
        (endpoint) => endpoint.Name === endpointName,
      );
      if (!targetEndpoint) {
        this.logger.warn(`Endpoint "${endpointName}" not found in Portainer.`);
        return [];
      }

      const endpointId = targetEndpoint.Id;
      const containers = await this.fetchPortainerResource<
        PortainerContainer[]
      >(
        `${this.baseUrl}/endpoints/${endpointId}/docker/containers/json`,
        `containers for endpoint-${endpointId}`,
      );

      return containers ?? [];
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Portainer is temporarily unavailable';
      this.logger.warn(`Returning empty containers list: ${message}`);
      return [];
    }
  }

  /**
   * Получение информации о конкретном контейнере + логи
   */
  async getContainer(containerId: string): Promise<PortainerContainer> {
    const endpointName = 'local';
    const endpoints = await this.fetchPortainerResource<any[]>(
      `${this.baseUrl}/endpoints`,
      'endpoints',
    );

    const targetEndpoint = endpoints.find(
      (endpoint) => endpoint.Name === endpointName,
    );
    if (!targetEndpoint) {
      throw new HttpException(
        `Endpoint "${endpointName}" not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const endpointId = targetEndpoint.Id;

    const containerDetails =
      await this.fetchPortainerResource<PortainerContainer>(
        `${this.baseUrl}/endpoints/${endpointId}/docker/containers/${containerId}/json`,
        `container details for ${containerId}`,
      );

    const logs = await this.fetchPortainerResource<string>(
      `${this.baseUrl}/endpoints/${endpointId}/docker/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true&tail=50`,
      `logs for container-${containerId}`,
    );

    containerDetails.Logs = logs;
    return containerDetails;
  }
}
