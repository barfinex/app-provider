import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

type MessageCallback = (data: any) => void;

interface SocketInfo {
    ws: WebSocket;
    retryCount: number;
    reconnecting: boolean;
    pingInterval?: NodeJS.Timeout;
    callbacks: MessageCallback[];
    activeSubs?: string[];   // 🔥 какие подписки есть
}

@Injectable()
export class WebSocketService {
    private readonly logger = new Logger(WebSocketService.name);

    private sockets = new Map<string, SocketInfo>();
    private readonly maxRetries = 5;
    private readonly baseDelay = 5000; // 5s

    /**
     * Подключение к конкретному WS-стриму
     */
    public async subscribeToStream(wsUrl: string): Promise<() => void> {
        const connectWebSocket = () => {
            this.logger.log(`Connecting to WebSocket at ${wsUrl}`);
            const ws = new WebSocket(wsUrl);

            const socketInfo: SocketInfo = {
                ws,
                retryCount: 0,
                reconnecting: false,
                callbacks: [],
            };
            this.sockets.set(wsUrl, socketInfo);

            // Таймаут коннекта
            const timeout = setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    this.logger.error(`WebSocket ${wsUrl} connection timed out`);
                    ws.close();
                }
            }, 30000);

            ws.on('open', () => {
                clearTimeout(timeout);
                this.logger.log(`WebSocket connected: ${wsUrl}`);
                socketInfo.retryCount = 0;

                // Запускаем ping каждые 30s
                socketInfo.pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.ping();
                    }
                }, 30000);
            });

            ws.on('pong', () => {
                this.logger.debug(`Pong received from ${wsUrl}`);
            });

            ws.on('message', (raw) => {
                try {
                    const msg = raw.toString();
                    const data = JSON.parse(msg);
                    socketInfo.callbacks.forEach((cb) => cb(data));
                } catch (e: any) {
                    this.logger.error(`Error parsing message from ${wsUrl}: ${e.message}`);
                }
            });

            ws.on('error', (err) => {
                this.logger.error(`WebSocket error on ${wsUrl}: ${err.message}`);
            });

            ws.on('close', (code, reason) => {
                clearTimeout(timeout);
                clearInterval(socketInfo.pingInterval);

                this.logger.warn(
                    `WebSocket closed ${wsUrl}. Code: ${code}, Reason: ${reason || 'none'}`,
                );

                // 🔥 попытка отписки
                if (socketInfo.activeSubs?.length) {
                    try {
                        const payload = {
                            method: 'UNSUBSCRIBE',
                            params: socketInfo.activeSubs,
                            id: Date.now(),
                        };
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(payload));
                            this.logger.log(
                                `Auto-UNSUBSCRIBE sent for ${socketInfo.activeSubs.length} streams on ${wsUrl}`,
                            );
                        }
                    } catch (err: any) {
                        this.logger.error(
                            `Failed auto-UNSUBSCRIBE on ${wsUrl}: ${err.message}`,
                        );
                    }
                }

                // ❌ удаляем старый сокет
                this.sockets.delete(wsUrl);

                if (!socketInfo.reconnecting) {
                    this.attemptReconnect(wsUrl, socketInfo.callbacks, socketInfo.retryCount);
                }
            });
        };

        connectWebSocket();

        return () => this.disconnect(wsUrl);
    }

    /**
     * Подписка на входящие сообщения по конкретному стриму
     */
    public onMessage(wsUrl: string, callback: MessageCallback): void {
        const socketInfo = this.sockets.get(wsUrl);
        if (!socketInfo) {
            throw new Error(`No active socket for ${wsUrl}`);
        }

        if (socketInfo.ws.readyState === WebSocket.OPEN) {
            socketInfo.callbacks.push(callback);
        } else {
            socketInfo.ws.once('open', () => {
                socketInfo.callbacks.push(callback);
            });
        }
    }


    /**
       * Событие onOpen — выполняется при успешном подключении
       */
    public onOpen(wsUrl: string, callback: (ws: WebSocket) => void): void {
        const socketInfo = this.sockets.get(wsUrl);
        if (!socketInfo) {
            throw new Error(`No active socket for ${wsUrl}`);
        }

        if (socketInfo.ws.readyState === WebSocket.OPEN) {
            callback(socketInfo.ws);
        } else {
            socketInfo.ws.once('open', () => callback(socketInfo.ws));
        }
    }

    /**
     * Вызов с активным WebSocket (если он открыт)
     */
    public withSocket(wsUrl: string, fn: (ws: WebSocket) => void): void {
        const socketInfo = this.sockets.get(wsUrl);
        if (socketInfo && socketInfo.ws.readyState === WebSocket.OPEN) {
            fn(socketInfo.ws);
        } else {
            this.logger.warn(`Socket not open for ${wsUrl}`);
        }
    }


    /**
     * Явное отключение
     */
    public disconnect(wsUrl: string): void {
        const socketInfo = this.sockets.get(wsUrl);
        if (!socketInfo) return;

        clearInterval(socketInfo.pingInterval);
        socketInfo.ws.close();
        this.sockets.delete(wsUrl);
        this.logger.log(`Disconnected from ${wsUrl}`);
    }

    /**
     * Автопереподключение
     */
    private attemptReconnect(wsUrl: string, callbacks: MessageCallback[], prevRetry: number): void {
        if (prevRetry < this.maxRetries) {
            const delay = Math.min(this.baseDelay * Math.pow(2, prevRetry), 30000);
            this.logger.warn(
                `Reconnecting to ${wsUrl} in ${delay / 1000}s (attempt ${prevRetry + 1}/${this.maxRetries})`,
            );

            setTimeout(() => {
                const socketInfo: SocketInfo = {
                    ws: null as any, // заменится в subscribeToStream
                    retryCount: prevRetry + 1,
                    reconnecting: false,
                    callbacks,
                };
                this.sockets.set(wsUrl, socketInfo);

                this.subscribeToStream(wsUrl).catch((err) =>
                    this.logger.error(`Reconnect to ${wsUrl} failed: ${err.message}`),
                );
            }, delay);
        } else {
            this.logger.error(`Max reconnect attempts reached for ${wsUrl}. Giving up.`);
            this.disconnect(wsUrl);
        }
    }
}
