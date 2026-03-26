import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../../../connector.service';
import {
  ConnectorType,
  MarketType,
  Subscription,
  SubscriptionType,
} from '@barfinex/types';

@Injectable()
export class ExchangeSubscriptionService {
  add(
    connectorType: ConnectorType,
    marketType: MarketType,
    subscription: Subscription,
  ): void {
    ConnectorService.addSubscription({
      connectorType,
      marketType,
      subscription,
    });
  }

  get(
    connectorType: ConnectorType,
    marketType: MarketType,
    subscriptionType: SubscriptionType,
  ): Subscription {
    return ConnectorService.getSubscription({
      connectorType,
      marketType,
      subscriptionType,
    });
  }
}
