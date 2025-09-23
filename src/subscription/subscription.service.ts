import { Injectable } from '@nestjs/common';
import { SubscriptionType } from '@barfinex/types'

@Injectable()
export class SubscriptionService {
    getAll(): string[] {
        const subscriptionTypes = Object.keys(SubscriptionType);
        return subscriptionTypes;
    }
}
