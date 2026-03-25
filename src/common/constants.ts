export const APP_URL =
  process.env.PROVIDER_API_URL || 'http://localhost:8081/api';
// export const APP_URL = 'https://mock.redq.io/api';

/** Событие: обновлён набор подписок на рыночные данные (символы/интервалы). Используется для подкачки и докачки свечей. */
export const CANDLE_SUBSCRIPTIONS_UPDATED = 'candle_subscriptions_updated';
