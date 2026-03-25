import { Injectable } from '@nestjs/common';
import { SubscriptionType } from '@barfinex/types';

export interface WsEventCatalogItem {
  systemName: string;
  namespace: '/' | '/eventsink';
  direction: 'server->client' | 'client->server';
  source: 'bridge' | 'gateway' | 'eventsink';
  nameRu: string;
  nameEn: string;
  descriptionRu: string;
  descriptionEn: string;
}

@Injectable()
export class WsEventsCatalogService {
  getCatalog(): {
    total: number;
    namespaces: Array<'/' | '/eventsink'>;
    items: WsEventCatalogItem[];
  } {
    const builtins: WsEventCatalogItem[] = [
      {
        systemName: 'health',
        namespace: '/',
        direction: 'client->server',
        source: 'gateway',
        nameRu: 'Проверка здоровья сокета',
        nameEn: 'Socket health check',
        descriptionRu:
          'Клиент отправляет событие для проверки доступности WebSocket-соединения.',
        descriptionEn:
          'Client emits this event to verify WebSocket availability.',
      },
      {
        systemName: 'health:ok',
        namespace: '/',
        direction: 'server->client',
        source: 'gateway',
        nameRu: 'Ответ проверки здоровья',
        nameEn: 'Health check response',
        descriptionRu:
          'Сервер подтверждает активность WS-канала и отправляет метку времени.',
        descriptionEn:
          'Server confirms WS channel is alive and returns a timestamp.',
      },
      {
        systemName: 'message',
        namespace: '/',
        direction: 'client->server',
        source: 'gateway',
        nameRu: 'Тестовое входящее сообщение',
        nameEn: 'Test inbound message',
        descriptionRu:
          'Служебное клиентское сообщение для проверки канала обмена.',
        descriptionEn: 'Utility client event used to validate message flow.',
      },
      {
        systemName: 'response',
        namespace: '/',
        direction: 'server->client',
        source: 'gateway',
        nameRu: 'Тестовый ответ сервера',
        nameEn: 'Test server response',
        descriptionRu: 'Служебный ответ на событие message.',
        descriptionEn: 'Utility response emitted for the message event.',
      },
      {
        systemName: 'event',
        namespace: '/eventsink',
        direction: 'server->client',
        source: 'eventsink',
        nameRu: 'Событие event-sink',
        nameEn: 'Event-sink event',
        descriptionRu:
          'Поток аналитических/аудит событий из event_sink namespace.',
        descriptionEn:
          'Analytics/audit event stream from event_sink namespace.',
      },
    ];

    const domainEvents = (Object.values(SubscriptionType) as string[]).map(
      (systemName) => this.toCatalogItem(systemName),
    );

    const items = [...builtins, ...domainEvents];
    return {
      total: items.length,
      namespaces: ['/', '/eventsink'],
      items,
    };
  }

  private toCatalogItem(systemName: string): WsEventCatalogItem {
    const [sourceRaw, ...rest] = systemName.split('_');
    const source = sourceRaw?.toUpperCase() || 'EVENT';
    const topic = rest.join('_');

    const sourceRuMap: Record<string, string> = {
      PROVIDER: 'Провайдер',
      INSPECTOR: 'Инспектор',
      DETECTOR: 'Детектор',
      ADVISOR: 'Советник',
    };
    const sourceEnMap: Record<string, string> = {
      PROVIDER: 'Provider',
      INSPECTOR: 'Inspector',
      DETECTOR: 'Detector',
      ADVISOR: 'Advisor',
    };

    const topicRu = this.topicToLabelRu(topic);
    const topicEn = this.topicToLabelEn(topic);
    const sourceRu = sourceRuMap[source] ?? source;
    const sourceEn = sourceEnMap[source] ?? source;

    return {
      systemName,
      namespace: '/',
      direction: 'server->client',
      source: 'bridge',
      nameRu: `${sourceRu}: ${topicRu}`,
      nameEn: `${sourceEn}: ${topicEn}`,
      descriptionRu: `Доменное событие ${sourceRu.toLowerCase()} (${systemName}), транслируемое через WS bridge.`,
      descriptionEn: `Domain event emitted by ${sourceEn.toLowerCase()} (${systemName}) and broadcast via WS bridge.`,
    };
  }

  private topicToLabelRu(topic: string): string {
    const map: Record<string, string> = {
      MARKETDATA_TRADE: 'Рыночные сделки',
      MARKETDATA_ORDERBOOK: 'Стакан',
      MARKETDATA_CANDLE: 'Свечи',
      ACCOUNT_EVENT: 'События счета',
      ORDER_CREATE: 'Создание ордера',
      ORDER_CLOSE: 'Закрытие ордера',
      SYMBOLS: 'Инструменты',
      SYMBOL_PRICES: 'Цены инструментов',
      TREND_DETECTED: 'Обнаружение тренда',
      RANGE_DETECTED: 'Обнаружение диапазона',
      VOLATILITY_SPIKE: 'Всплеск волатильности',
      LIQUIDITY_DROPPED: 'Падение ликвидности',
      DATA_GAP_DETECTED: 'Разрыв данных',
      DATA_OUTLIER_DETECTED: 'Выброс данных',
      DATA_MATURITY_UPDATE: 'Обновление зрелости данных',
      RISK_LIMIT_BREACH: 'Нарушение лимита риска',
      RISK_MARGIN_UPDATE: 'Обновление маржи риска',
      RISK_KILL_SWITCH: 'Аварийная остановка риска',
      SIGNAL_GENERATED: 'Сигнал сгенерирован',
      SIGNAL_UPDATED: 'Сигнал обновлен',
      SIGNAL_INVALIDATED: 'Сигнал аннулирован',
      POSITION_OPEN_REQUEST: 'Запрос открытия позиции',
      POSITION_CLOSE_REQUEST: 'Запрос закрытия позиции',
      POSITION_REDUCE_REQUEST: 'Запрос сокращения позиции',
      POSITION_FLIP_REQUEST: 'Запрос разворота позиции',
      DECISION_REQUEST: 'Запрос решения',
      DECISION_RESPONSE: 'Ответ решения',
      DECISION_CONTEXT_SNAPSHOT: 'Снимок контекста решения',
      CONFIDENCE_LOW: 'Низкая уверенность',
      MODEL_SWITCHED: 'Смена модели',
      HALLUCINATION_DETECTED: 'Обнаружена галлюцинация',
    };
    return map[topic] ?? topic.replace(/_/g, ' ').toLowerCase();
  }

  private topicToLabelEn(topic: string): string {
    const map: Record<string, string> = {
      MARKETDATA_TRADE: 'Market trades',
      MARKETDATA_ORDERBOOK: 'Order book',
      MARKETDATA_CANDLE: 'Candles',
      ACCOUNT_EVENT: 'Account event',
      ORDER_CREATE: 'Order create',
      ORDER_CLOSE: 'Order close',
      SYMBOLS: 'Symbols',
      SYMBOL_PRICES: 'Symbol prices',
      TREND_DETECTED: 'Trend detected',
      RANGE_DETECTED: 'Range detected',
      VOLATILITY_SPIKE: 'Volatility spike',
      LIQUIDITY_DROPPED: 'Liquidity dropped',
      DATA_GAP_DETECTED: 'Data gap detected',
      DATA_OUTLIER_DETECTED: 'Data outlier detected',
      DATA_MATURITY_UPDATE: 'Data maturity update',
      RISK_LIMIT_BREACH: 'Risk limit breach',
      RISK_MARGIN_UPDATE: 'Risk margin update',
      RISK_KILL_SWITCH: 'Risk kill switch',
      SIGNAL_GENERATED: 'Signal generated',
      SIGNAL_UPDATED: 'Signal updated',
      SIGNAL_INVALIDATED: 'Signal invalidated',
      POSITION_OPEN_REQUEST: 'Position open request',
      POSITION_CLOSE_REQUEST: 'Position close request',
      POSITION_REDUCE_REQUEST: 'Position reduce request',
      POSITION_FLIP_REQUEST: 'Position flip request',
      DECISION_REQUEST: 'Decision request',
      DECISION_RESPONSE: 'Decision response',
      DECISION_CONTEXT_SNAPSHOT: 'Decision context snapshot',
      CONFIDENCE_LOW: 'Low confidence',
      MODEL_SWITCHED: 'Model switched',
      HALLUCINATION_DETECTED: 'Hallucination detected',
    };
    return map[topic] ?? topic.replace(/_/g, ' ').toLowerCase();
  }
}
