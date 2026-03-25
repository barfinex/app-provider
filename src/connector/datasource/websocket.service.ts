import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';

type MessageCallback = (data: any) => void;
type SubscribeStreamOptions = {
  stallThresholdMs?: number;
};

interface SocketInfo {
  ws: WebSocket;
  retryCount: number;
  reconnecting: boolean;
  reconnectTimer?: NodeJS.Timeout;
  pingInterval?: NodeJS.Timeout;
  stallWatchInterval?: NodeJS.Timeout;
  lastMessageAt?: number;
  callbacks: MessageCallback[];
  openCallbacks: Array<(ws: WebSocket) => void>;
  activeSubs?: string[];
  /** Set when disconnect() is called — do not attempt reconnect on close */
  intentionalClose?: boolean;
  stallThresholdMs?: number;
  stallCooldownUntil?: number;
  lastStallWarnAt?: number;
}

@Injectable()
export class WebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(WebSocketService.name);

  private sockets = new Map<string, SocketInfo>();
  private readonly maxRetries = Math.max(
    0,
    Number(process.env.BINANCE_WS_MAX_RETRIES || 0),
  ); // 0 = unlimited retries
  private readonly baseDelay = Math.max(
    500,
    Number(process.env.BINANCE_WS_RECONNECT_BASE_DELAY_MS || 5_000),
  );
  private readonly maxDelay = Math.max(
    this.baseDelay,
    Number(process.env.BINANCE_WS_RECONNECT_MAX_DELAY_MS || 30_000),
  );
  private readonly reconnectJitterMs = Math.max(
    0,
    Number(process.env.BINANCE_WS_RECONNECT_JITTER_MS || 1_500),
  );
  private readonly stallThresholdMs = Math.max(
    1000,
    Number(process.env.BINANCE_WS_STALL_THRESHOLD_MS || 5_000),
  );
  private readonly stallCheckMs = Math.max(
    500,
    Number(process.env.BINANCE_WS_STALL_CHECK_INTERVAL_MS || 1_000),
  );
  private readonly stallCooldownMs = Math.max(
    1_000,
    Number(process.env.BINANCE_WS_STALL_COOLDOWN_MS || 10_000),
  );
  private readonly stallWarnThrottleMs = Math.max(
    1_000,
    Number(process.env.BINANCE_WS_STALL_WARN_THROTTLE_MS || 10_000),
  );
  private readonly transientErrorWarnThrottleMs = 10_000;
  private lastTransientErrorAt = 0;

  /**
   * Подключение к конкретному WS-стриму
   */
  public async subscribeToStream(
    wsUrl: string,
    options?: SubscribeStreamOptions,
  ): Promise<() => void> {
    // =========================================================================
    // 🔒 GUARD: не создаём второй WebSocket для того же wsUrl
    // =========================================================================
    const existing = this.sockets.get(wsUrl);
    const preservedCallbacks = existing?.callbacks ?? [];
    const preservedOpenCallbacks = existing?.openCallbacks ?? [];
    const preservedStallThresholdMs =
      options?.stallThresholdMs ?? existing?.stallThresholdMs;
    if (existing) {
      const state = existing.ws?.readyState;

      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        this.logger.debug(
          `Reusing existing WebSocket for ${wsUrl} (state=${state})`,
        );
        return () => this.disconnect(wsUrl);
      }
    }

    const connectWebSocket = () => {
      this.logger.log(`Connecting to WebSocket at ${wsUrl}`);
      const ws = new WebSocket(wsUrl);

      const socketInfo: SocketInfo = {
        ws,
        retryCount: 0,
        reconnecting: false,
        callbacks: preservedCallbacks,
        openCallbacks: preservedOpenCallbacks,
        lastMessageAt: Date.now(),
        stallThresholdMs: preservedStallThresholdMs,
        stallCooldownUntil: 0,
        lastStallWarnAt: 0,
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
        socketInfo.reconnecting = false; // 🔥 фикс состояния

        // Запускаем ping каждые 30s
        socketInfo.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 30000);

        socketInfo.lastMessageAt = Date.now();
        for (const openCallback of socketInfo.openCallbacks) {
          try {
            openCallback(ws);
          } catch (error) {
            this.logger.error(
              `Error running onOpen callback for ${wsUrl}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        socketInfo.stallWatchInterval = setInterval(() => {
          if (socketInfo.intentionalClose) return;
          if (socketInfo.reconnecting) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          const now = Date.now();
          if (now < (socketInfo.stallCooldownUntil ?? 0)) return;
          const lastMessageAt = socketInfo.lastMessageAt ?? Date.now();
          const thresholdMs =
            socketInfo.stallThresholdMs ?? this.stallThresholdMs;
          const ageMs = now - lastMessageAt;
          if (ageMs <= thresholdMs) return;
          if (
            now - (socketInfo.lastStallWarnAt ?? 0) >=
            this.stallWarnThrottleMs
          ) {
            this.logger.warn(
              `WebSocket stall detected for ${wsUrl}; lastMessageAgeMs=${ageMs} thresholdMs=${thresholdMs}. Forcing reconnect`,
            );
            socketInfo.lastStallWarnAt = now;
          }
          socketInfo.stallCooldownUntil = now + this.stallCooldownMs;
          try {
            ws.terminate();
          } catch {
            ws.close();
          }
        }, this.stallCheckMs);
      });

      ws.on('pong', () => {
        this.logger.debug(`Pong received from ${wsUrl}`);
      });

      ws.on('message', (raw) => {
        try {
          socketInfo.lastMessageAt = Date.now();
          const msg = raw.toString();
          const data = JSON.parse(msg);
          socketInfo.callbacks.forEach((cb) => cb(data));
        } catch (e: any) {
          this.logger.error(
            `Error parsing message from ${wsUrl}: ${e.message}`,
          );
        }
      });

      ws.on('error', (err) => {
        if (socketInfo.intentionalClose) {
          this.logger.debug(
            `WebSocket closed before connect (intentional): ${wsUrl}`,
          );
          return;
        }
        if (this.isTransientSocketError(err)) {
          const now = Date.now();
          if (
            now - this.lastTransientErrorAt >=
            this.transientErrorWarnThrottleMs
          ) {
            this.lastTransientErrorAt = now;
            this.logger.warn(
              `WebSocket transient error on ${wsUrl}: ${err.message}`,
            );
          }
          return;
        }
        this.logger.error(`WebSocket error on ${wsUrl}: ${err.message}`);
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        clearInterval(socketInfo.pingInterval);
        clearInterval(socketInfo.stallWatchInterval);

        if (!socketInfo.intentionalClose) {
          this.logger.warn(
            `WebSocket closed ${wsUrl}. Code: ${code}, Reason: ${
              reason || 'none'
            }`,
          );
        }

        // попытка отписки (только если открыт)
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

        this.sockets.delete(wsUrl);
        if (socketInfo.reconnectTimer) {
          clearTimeout(socketInfo.reconnectTimer);
          socketInfo.reconnectTimer = undefined;
        }

        if (socketInfo.intentionalClose) return;
        if (!socketInfo.reconnecting) {
          socketInfo.reconnecting = true;
          this.attemptReconnect(
            wsUrl,
            socketInfo.callbacks,
            socketInfo.openCallbacks,
            socketInfo.retryCount,
            { stallThresholdMs: socketInfo.stallThresholdMs },
          );
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
    const hasCallback = socketInfo.callbacks.some((cb) => cb === callback);
    if (hasCallback) return;
    if (!socketInfo.ws || typeof socketInfo.ws.once !== 'function') {
      socketInfo.callbacks.push(callback);
      return;
    }

    if (socketInfo.ws.readyState === WebSocket.OPEN) {
      socketInfo.callbacks.push(callback);
    } else {
      socketInfo.ws.once('open', () => {
        if (socketInfo.callbacks.some((cb) => cb === callback)) return;
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
    const hasCallback = socketInfo.openCallbacks.some((cb) => cb === callback);
    if (!hasCallback) {
      socketInfo.openCallbacks.push(callback);
    }
    if (!socketInfo.ws || typeof socketInfo.ws.once !== 'function') {
      return;
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
  public withSocket(wsUrl: string, fn: (socketInfo: SocketInfo) => void): void {
    const socketInfo = this.sockets.get(wsUrl);
    if (socketInfo && socketInfo.ws.readyState === WebSocket.OPEN) {
      fn(socketInfo); // передаём весь объект
    } else {
      this.logger.warn(`Socket not open for ${wsUrl}`);
    }
  }

  onModuleDestroy(): void {
    const urls = Array.from(this.sockets.keys());
    for (const wsUrl of urls) {
      this.disconnect(wsUrl);
    }
    this.logger.log(
      `WebSocketService shutdown: disconnected ${urls.length} socket(s)`,
    );
  }

  /**
   * Remove a previously registered message callback.
   */
  public offMessage(wsUrl: string, callback: MessageCallback): void {
    const socketInfo = this.sockets.get(wsUrl);
    if (!socketInfo) return;
    const idx = socketInfo.callbacks.indexOf(callback);
    if (idx >= 0) socketInfo.callbacks.splice(idx, 1);
  }

  /**
   * Remove a previously registered open callback.
   */
  public offOpen(wsUrl: string, callback: (ws: WebSocket) => void): void {
    const socketInfo = this.sockets.get(wsUrl);
    if (!socketInfo) return;
    const idx = socketInfo.openCallbacks.indexOf(callback);
    if (idx >= 0) socketInfo.openCallbacks.splice(idx, 1);
  }

  /**
   * Явное отключение
   */
  public disconnect(wsUrl: string): void {
    const socketInfo = this.sockets.get(wsUrl);
    if (!socketInfo) return;

    socketInfo.intentionalClose = true;
    if (socketInfo.reconnectTimer) {
      clearTimeout(socketInfo.reconnectTimer);
      socketInfo.reconnectTimer = undefined;
    }
    clearInterval(socketInfo.pingInterval);
    clearInterval(socketInfo.stallWatchInterval);
    if (socketInfo.ws && typeof socketInfo.ws.close === 'function') {
      socketInfo.ws.close();
    }
    this.sockets.delete(wsUrl);
    this.logger.log(`Disconnected from ${wsUrl}`);
  }

  /**
   * Автопереподключение
   */
  private attemptReconnect(
    wsUrl: string,
    callbacks: MessageCallback[],
    openCallbacks: Array<(ws: WebSocket) => void>,
    prevRetry: number,
    options?: SubscribeStreamOptions,
  ): void {
    const nextAttempt = prevRetry + 1;
    const maxRetriesReached =
      this.maxRetries > 0 && nextAttempt > this.maxRetries;
    if (maxRetriesReached) {
      this.logger.warn(
        `Reconnect cap reached for ${wsUrl}; continuing retries to preserve stream availability`,
      );
    }

    const baseDelay = Math.min(
      this.baseDelay * Math.pow(2, Math.min(prevRetry, 10)),
      this.maxDelay,
    );
    const delay = this.withReconnectJitter(baseDelay);
    this.logger.warn(
      this.maxRetries > 0
        ? `Reconnecting to ${wsUrl} in ${
            delay / 1000
          }s (attempt ${nextAttempt}/${
            this.maxRetries
          }, baseDelayMs=${baseDelay})`
        : `Reconnecting to ${wsUrl} in ${
            delay / 1000
          }s (attempt ${nextAttempt}, unlimited, baseDelayMs=${baseDelay})`,
    );

    const reconnectTimer = setTimeout(() => {
      const current = this.sockets.get(wsUrl);
      if (current?.intentionalClose) return;
      this.subscribeToStream(wsUrl, options).catch((err) =>
        this.logger.error(`Reconnect to ${wsUrl} failed: ${err.message}`),
      );
    }, delay);
    this.sockets.set(wsUrl, {
      ws: null as any,
      retryCount: nextAttempt,
      reconnecting: true,
      callbacks,
      openCallbacks,
      reconnectTimer,
    });
  }

  private withReconnectJitter(baseDelayMs: number): number {
    if (this.reconnectJitterMs <= 0) return baseDelayMs;
    const jitterMs = Math.floor(Math.random() * (this.reconnectJitterMs + 1));
    return baseDelayMs + jitterMs;
  }

  private isTransientSocketError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    const message = String(
      (error as { message?: unknown })?.message || error || '',
    ).toLowerCase();
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE' ||
      message.includes('econnreset') ||
      message.includes('econnaborted') ||
      message.includes('socket hang up') ||
      message.includes('connection reset') ||
      message.includes('connection closed')
    );
  }
}
