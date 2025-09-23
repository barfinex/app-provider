import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { decode } from 'jsonwebtoken';
import { PortainerContainer, PortainerLog } from './portainer.interface';

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

@Injectable()
export class PortainerService {
    private readonly logger = new Logger(PortainerService.name);
    private readonly baseUrl = `http://${process.env.PONTEINER_HOST}:${process.env.PONTEINER_PORT}/api`;
    private token: string | null = null;

    private readonly username = process.env.PONTEINER_ADMIN_USERNAME;
    private readonly password = process.env.PONTEINER_ADMIN_PASSWORD;
    private cache: Record<string, CacheEntry<any>> = {};



    // Проверка, истек ли токен
    isTokenExpired(token: string): boolean {
        try {
            const { exp } = decode(token) as {
                exp: number;
            };
            const currentTime = Math.floor(Date.now() / 1000);
            return exp < currentTime;
        } catch (error) {
            console.error('Failed to decode token:', error.message);
            return true;
        }
    }

    // Аутентификация
    private async authenticate() {
        if (!this.username || !this.password) {
            this.logger.error('Portainer admin credentials are not set in the environment variables');
            throw new HttpException(
                'Portainer admin credentials are not set in the environment variables',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }

        try {
            // this.logger.log('Authenticating with Portainer...');
            const response = await axios.post(`${this.baseUrl}/auth`, {
                Username: this.username,
                Password: this.password,
            });

            if (response.data && response.data.jwt) {
                this.token = response.data.jwt;
                // this.logger.log('Authentication successful, token obtained.');
            } else {
                this.logger.error('Failed to authenticate with Portainer');
                throw new HttpException('Failed to authenticate with Portainer', HttpStatus.UNAUTHORIZED);
            }
        } catch (error) {
            this.logger.error(`Authentication error: ${error.message}`);
            throw new HttpException(
                error.response?.data?.message || 'Authentication error',
                HttpStatus.UNAUTHORIZED,
            );
        }
    }

    // Проверка и обновление токена
    private async ensureAuthenticated() {
        if (!this.token || this.isTokenExpired(this.token)) {
            this.logger.warn('Token is missing or expired. Authenticating...');
            await this.authenticate();
        }
    }

    // Универсальный запрос к ресурсу Portainer
    async fetchPortainerResource<T>(url: string, resourceName: string): Promise<T> {
        await this.ensureAuthenticated(); // Проверяем токен перед запросом

        try {
            // this.logger.log(`Fetching ${resourceName} from URL: ${url}...`);
            const response = await axios.get<T>(url, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                },
            });
            // this.logger.log(`Successfully fetched ${resourceName}: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Error fetching ${resourceName}: ${error.message}`);
            throw new HttpException(
                error.response?.data?.message || `Failed to fetch ${resourceName}`,
                error.response?.status || HttpStatus.BAD_REQUEST,
            );
        }
    }

    // Получение контейнеров
    async getContainers(): Promise<PortainerContainer[]> {
        const endpointName: string = 'local';

        const endpoints = await this.fetchPortainerResource<any[]>(
            `${this.baseUrl}/endpoints`,
            'endpoints'
        );

        const targetEndpoint = endpoints.find((endpoint: any) => endpoint.Name === endpointName);
        if (!targetEndpoint) {
            throw new HttpException(
                `Endpoint "${endpointName}" not found.`,
                HttpStatus.NOT_FOUND,
            );
        }

        const endpointId = targetEndpoint.Id;
        // this.logger.log(`Found endpoint "${endpointName}" with ID ${endpointId}.`);

        const containers = await this.fetchPortainerResource<PortainerContainer[]>(
            `${this.baseUrl}/endpoints/${endpointId}/docker/containers/json`,
            `containers for endpoint-${endpointId}`
        );

        if (!containers.length) {
            throw new HttpException(
                `No containers found for endpoint ${endpointId}.`,
                HttpStatus.NOT_FOUND,
            );
        }

        return containers;
    }

    // Получение логов контейнера
    async getContainer(containerId: string): Promise<PortainerContainer> {
        const endpointName: string = 'local';

        const endpoints = await this.fetchPortainerResource<any[]>(
            `${this.baseUrl}/endpoints`,
            'endpoints'
        );

        const targetEndpoint = endpoints.find((endpoint: any) => endpoint.Name === endpointName);
        if (!targetEndpoint) {
            throw new HttpException(
                `Endpoint "${endpointName}" not found.`,
                HttpStatus.NOT_FOUND,
            );
        }

        const endpointId = targetEndpoint.Id;
        // this.logger.log(`Found endpoint "${endpointName}" with ID ${endpointId}.`);


        // Запрашиваем информацию о контейнере
        const containerDetails = await this.fetchPortainerResource<PortainerContainer>(
            `${this.baseUrl}/endpoints/${endpointId}/docker/containers/${containerId}/json`,
            `container details for ${containerId}`
        );



        const logs = await this.fetchPortainerResource<string>(
            `${this.baseUrl}/endpoints/${endpointId}/docker/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true&tail=50`,
            `logs for container-${containerId}`
        );

        // const parsedLogs: PortainerLog[] = logs.split('\n').map((logLine) => {
        //     const [timestamp, streamWithMessage] = logLine.split(' ', 2);
        //     if (!timestamp || !streamWithMessage) {
        //         return null;
        //     }
        //     const [stream, ...messageParts] = streamWithMessage.split(':');
        //     return {
        //         timestamp,
        //         stream: stream.trim() as 'stdout' | 'stderr',
        //         message: messageParts.join(':').trim(),
        //     };
        // }).filter((log) => log !== null);

        // Добавляем логи к информации о контейнере
        containerDetails.Logs = logs;

        // this.logger.log(`Fetched logs for container "${containerId}".`);
        return containerDetails;
    }
}