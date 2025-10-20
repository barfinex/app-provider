import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { decode } from 'jsonwebtoken';
import { PortainerContainer } from './portainer.interface';

@Injectable()
export class PortainerService {
    private readonly logger = new Logger(PortainerService.name);
    private readonly baseUrl = `http://${process.env.PONTEINER_HOST}:${process.env.PONTEINER_PORT}/api`;
    private token: string | null = null;

    private readonly username = process.env.PONTEINER_ADMIN_USERNAME;
    private readonly password = process.env.PONTEINER_ADMIN_PASSWORD;

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
        if (!this.username || !this.password) {
            const msg = 'Portainer admin credentials are not set in environment variables';
            this.logger.error(msg);
            throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            const response = await axios.post<{ jwt: string }>(`${this.baseUrl}/auth`, {
                Username: this.username,
                Password: this.password,
            });

            if (response.data?.jwt) {
                this.token = response.data.jwt;
                this.logger.log('Authentication successful.');
            } else {
                throw new HttpException('Failed to authenticate with Portainer', HttpStatus.UNAUTHORIZED);
            }
        } catch (error: unknown) {
            const err = error as AxiosError<{ message?: string }>;
            const message = err.response?.data?.message || err.message || 'Authentication error';
            this.logger.error(`Authentication error: ${message}`);
            throw new HttpException(message, HttpStatus.UNAUTHORIZED);
        }
    }

    /**
     * Проверка и обновление токена
     */
    private async ensureAuthenticated(): Promise<void> {
        if (!this.token || this.isTokenExpired(this.token)) {
            this.logger.warn('Token is missing or expired. Authenticating...');
            await this.authenticate();
        }
    }

    /**
     * Универсальный запрос к Portainer API с типобезопасной обработкой ошибок
     */
    async fetchPortainerResource<T>(url: string, resourceName: string): Promise<T> {
        await this.ensureAuthenticated();

        try {
            const response = await axios.get<T>(url, {
                headers: { Authorization: `Bearer ${this.token}` },
            });
            return response.data;
        } catch (error: unknown) {
            const err = error as AxiosError<{ message?: string }>;
            const message = err.response?.data?.message || err.message || `Failed to fetch ${resourceName}`;
            const status = err.response?.status || HttpStatus.BAD_REQUEST;

            this.logger.error(`Error fetching ${resourceName}: ${message}`);
            throw new HttpException(message, status);
        }
    }

    /**
     * Получение всех контейнеров Portainer
     */
    async getContainers(): Promise<PortainerContainer[]> {
        const endpointName = 'local';
        const endpoints = await this.fetchPortainerResource<any[]>(`${this.baseUrl}/endpoints`, 'endpoints');

        const targetEndpoint = endpoints.find((endpoint) => endpoint.Name === endpointName);
        if (!targetEndpoint) {
            throw new HttpException(`Endpoint "${endpointName}" not found.`, HttpStatus.NOT_FOUND);
        }

        const endpointId = targetEndpoint.Id;
        const containers = await this.fetchPortainerResource<PortainerContainer[]>(
            `${this.baseUrl}/endpoints/${endpointId}/docker/containers/json`,
            `containers for endpoint-${endpointId}`,
        );

        if (!containers.length) {
            throw new HttpException(`No containers found for endpoint ${endpointId}.`, HttpStatus.NOT_FOUND);
        }

        return containers;
    }

    /**
     * Получение информации о конкретном контейнере + логи
     */
    async getContainer(containerId: string): Promise<PortainerContainer> {
        const endpointName = 'local';
        const endpoints = await this.fetchPortainerResource<any[]>(`${this.baseUrl}/endpoints`, 'endpoints');

        const targetEndpoint = endpoints.find((endpoint) => endpoint.Name === endpointName);
        if (!targetEndpoint) {
            throw new HttpException(`Endpoint "${endpointName}" not found.`, HttpStatus.NOT_FOUND);
        }

        const endpointId = targetEndpoint.Id;

        const containerDetails = await this.fetchPortainerResource<PortainerContainer>(
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
